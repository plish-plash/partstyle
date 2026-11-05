# Firmware notes

What firmware needs to know, written at hand-off: pin assignments, peripherals, clocks,
programming and debug access, reset and boot requirements.

| Net                   | Pin           | Use                                |
| --------------------- | ------------- | ---------------------------------- |
| `AIN`                 | ADC7          | Sensor input through the U3 buffer |
| `TXD`, `RXD`          | PD1, PD0      | UART on J5                         |
| `LED`                 | PB1           | Status LED D4, active high         |
| `MOSI`, `MISO`, `SCK` | PB3, PB4, PB5 | ISP on J3                          |
| `RESET`               | RESET         | Pulled up by R5; also on J3        |

- Clock: internal 8 MHz RC oscillator, with no crystal. Clear the CKDIV8 fuse to run at 8 MHz.
- ADC: use AVCC as the reference, since the sensor spans 0-3.3 V. C12 bypasses AREF.
- Programming: AVR ISP on J3.
- Spare pins: the other port pins are unconnected. Enable pull-ups so their inputs don't float.
