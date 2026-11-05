# Design

A bench interface that reads a remote analog sensor on a 2 m cable and reports it over UART.

## power

A 12 V wall adapter enters at J1. D1 blocks reverse polarity, U1 makes 5 V for the sensor, and U2
makes 3.3 V from that 5 V for the op-amp and MCU, which keeps U2 under its 6 V limit. D2 shows
power is on.

## sensor_afe

The sensor connects at J2 and is powered from +5V. D3 clamps ESD at the connector, R2 limits the
clamp current and forms a 16 kHz low-pass with C6, and R4 pulls the input to 0 V when the sensor is
unplugged. U3 buffers the signal, R3 isolates it from the ADC's sample capacitor, and C7 supplies
the charge. The spare half of U3 is a grounded follower.

## mcu

U4 runs at 3.3 V on its internal 8 MHz RC oscillator. It reads the sensor on ADC7 and reports over
UART on J5, is programmed through the ISP header J3, and drives status LED D4.
