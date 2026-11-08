# Design record

Every change to the design, and why. Append-only: new entries go at the end.

- 2026-11-04: Accepted a 12 V miswire on AFE/J2: on a bench tool it may destroy D3, but R2 keeps it out of U3.
- 2026-11-04: No ESD clamp on MCU/J5: it's a bench debug header for a grounded USB-UART adapter.
- 2026-11-07: Moved to seed library parts: J1 to PJ-102AH (the same jack), D1 from 1N5819 to SS14 (its SMA equivalent), U2 from MCP1700-3302 to AP2112K-3.3 with EN tied to +5V.
