from soma.anim import Animation

a = Animation('FEM bar orbit')
a.camera.set(view='iso')
a.caption('40 x 10 x 10 mm axial bar')
a.play(a.camera.orbit(90), run_time=2)
