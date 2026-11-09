from soma.fem import Study
study = Study('Axial bar benchmark', material='Aluminium 6082', mesh=3,
              across_layers=False, check_mesh=True)
study.fix('Bar', faces='<X')
study.force('Bar', faces='>X', N=(100, 0, 0))
