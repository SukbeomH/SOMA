import cadquery as cq
from soma import add_part
# Axially loaded bar; mm. Numerical integration check, not a product load case.
add_part('Bar', cq.Workplane('XY').box(40, 10, 10, centered=(False, False, False)))
