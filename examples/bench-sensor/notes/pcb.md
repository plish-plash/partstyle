# PCB notes

Layout guidance, written at hand-off: layer count, keep-outs, placement constraints.

- Two layers, with a ground pour on the bottom.
- PWR: U1 drops 7 V across its load, so leave copper or room for a heatsink at its tab. Place C1 and
  C2 at U1, and C4 and C5 at U2.
- AFE: place D3 at J2, then R2, so an ESD strike is clamped before it crosses the board. Keep SENSE
  short and away from the UART lines. Place C8 at U3.
- MCU: place C9, C10, C11 and C12 at their pins on U4. Place R3 and C7 near the ADC7 pin.
- Keep J2, J3 and J5 at the board edge.
