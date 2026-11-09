"""Regression: export a Solid without iterating it into its Shells."""
import tempfile
from pathlib import Path
import cadquery as cq
from soma.cli import _export_one

with tempfile.TemporaryDirectory(prefix='soma-step-') as directory:
    shapes = [
        cq.Workplane('XY').box(60,40,25,centered=(True,True,False)).edges('|Z').fillet(4).faces('>Z').shell(-2).val(),
        cq.Workplane('XY').box(30,20,2).faces('>Z').workplane().hole(8).val(),
    ]
    shapes.append(cq.Compound.makeCompound([shapes[0], shapes[1].translate((100,0,0))]))
    for i, shape in enumerate(shapes):
        for fmt in ['step', 'brep']:
            output = Path(directory)/f'{i}.{fmt}'
            _export_one(shape, fmt, output)
            imported = cq.importers.importStep(str(output)).val() if fmt == 'step' else cq.Shape.importBrep(str(output))
            assert imported.isValid()
            assert len(imported.Solids()) == len(shape.Solids())
            assert abs(imported.Volume()-shape.Volume()) < 1e-6
            a,b=imported.BoundingBox(),shape.BoundingBox()
            assert max(abs(getattr(a,k)-getattr(b,k)) for k in ['xmin','xmax','ymin','ymax','zmin','zmax'])<1e-6
print('PASS: Solid, hollow body, perforated lid and compound retain topology, volume and bounds in STEP/BREP')
