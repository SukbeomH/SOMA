"""Verify the SOMA box/lid browser test; no UI or model mutation.
Usage: .venv/bin/python validation/verify_model.py PROJECT 8 [EXPORT_DIR]
Exports must already exist in PROJECT/exports/hole8 (or hole10).
"""
import json
import math
from pathlib import Path
import runpy
import sys
import cadquery as cq
from soma import params, registry
from vtkmodules.vtkIOGeometry import vtkSTLReader
from vtkmodules.vtkFiltersCore import vtkFeatureEdges, vtkMassProperties

root = Path(sys.argv[1]).resolve()
diameter = float(sys.argv[2])
params.begin(root)
registry.REGISTRY.clear()
model = runpy.run_path(str(root / 'model.py'))
body, lid = model['body'].val(), model['lid'].val()
original_body = (cq.Workplane('XY').box(60, 40, 25, centered=(True, True, False))
                 .edges('|Z').fillet(4).faces('>Z').shell(-2).val())
assert body.isValid() and lid.isValid()
assert len(body.Solids()) == len(lid.Solids()) == 1
assert abs(body.Volume() - original_body.Volume()) < 1e-6
assert body.cut(original_body).Volume() < 1e-6
assert original_body.cut(body).Volume() < 1e-6
bb = lid.BoundingBox()
assert all(abs(a-b) < 1e-6 for a,b in zip((bb.xmin,bb.xmax,bb.ymin,bb.ymax,bb.zmin,bb.zmax),(-30,30,-20,20,25,27)))
expected = (60*40 - (4-math.pi)*4**2 - math.pi*(diameter/2)**2)*2
assert abs(lid.Volume()-expected) < 1e-6
# Exact cylindrical surface at the origin, spanning the full lid thickness.
holes=[]
for face in lid.Faces():
    if face.geomType() != 'CYLINDER': continue
    cylinder=face._geomAdaptor().Cylinder()
    p=cylinder.Location(); fbb=face.BoundingBox()
    if abs(p.X())<1e-6 and abs(p.Y())<1e-6:
        assert abs(cylinder.Radius()*2-diameter)<1e-6
        assert abs(fbb.zmin-25)<1e-6 and abs(fbb.zmax-27)<1e-6
        holes.append({'center':[p.X(),p.Y()], 'diameter':2*cylinder.Radius(), 'z':[fbb.zmin,fbb.zmax]})
assert len(holes)==1
exports=Path(sys.argv[3]).resolve() if len(sys.argv)>3 else root/'exports'/f'hole{diameter:g}'
report={'hole':holes[0], 'tolerance_mm':1e-6, 'volume_tolerance_mm3':1e-6,
        'lid_volume_mm3':lid.Volume(), 'expected_lid_volume_mm3':expected,
        'body_unchanged':True,'valid_single_solids':2,'exports':{},'stl_units':'mm (not embedded in STL)', 'stl_requested_tolerance_mm':0.01}
for name,shape in [('Body',body),('Lid',lid)]:
    step=cq.importers.importStep(str(exports/f'{name}.step')).val()
    assert step.isValid() and len(step.Solids())==1
    assert abs(step.Volume()-shape.Volume())<1e-6
    sbb=step.BoundingBox(); bounds=(sbb.xmin,sbb.xmax,sbb.ymin,sbb.ymax,sbb.zmin,sbb.zmax)
    ob=shape.BoundingBox(); original=(ob.xmin,ob.xmax,ob.ymin,ob.ymax,ob.zmin,ob.zmax)
    assert max(abs(a-b) for a,b in zip(bounds,original))<1e-6
    reader=vtkSTLReader(); reader.SetFileName(str(exports/f'{name}.stl')); reader.MergingOn(); reader.Update()
    mesh=reader.GetOutput()
    edges=vtkFeatureEdges(); edges.SetInputData(mesh); edges.BoundaryEdgesOn(); edges.NonManifoldEdgesOn(); edges.FeatureEdgesOff(); edges.ManifoldEdgesOff(); edges.Update()
    assert edges.GetOutput().GetNumberOfCells()==0
    mass=vtkMassProperties(); mass.SetInputData(mesh); mass.Update()
    err=abs(mass.GetVolume()-shape.Volume())/shape.Volume()
    assert err<0.001
    assert max(abs(a-b) for a,b in zip(mesh.GetBounds(),original))<0.01
    report['exports'][name]={'step_valid':True,'step_bounds_mm':bounds,'step_volume_mm3':step.Volume(),
      'stl_closed_manifold':True,'stl_triangles':mesh.GetNumberOfCells(),'stl_volume_mm3':mass.GetVolume(),
      'stl_volume_relative_error':err,'stl_bounds_mm':mesh.GetBounds()}
print(json.dumps(report,indent=2))
