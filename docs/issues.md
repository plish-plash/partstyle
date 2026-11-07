# Issue codes

An issue is a hint to retry, a design fault, or something for the person to decide. An error is a
design fault that must be fixed: it cannot be waived, and it blocks export. A warning asks for a
fix or the person's decision.

An unconnected pin is reported unless it may stay open: an `nc` statement or `unused: open` in the
part record says so, and a `bidir`, output-type or `nc` pin needs nothing unless the record says
`unused: required`. A `power_in` pin is always reported.

A net is ground when it crosses a `ground` port or its name says so (`GND`, `AGND`, `VSS`, `0V`);
ground needs no source. A `{source: ...}` attribute says a net is driven or supplied from outside
the design, which also answers `undriven-input` and `no-pull`.

| Code                                                            | Severity                           | Meaning                                                                |
| --------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| `parse.syntax`, `parse.missing-block`                           | error                              | malformed statement                                                    |
| `elab.unknown-part/-pin/-ref/-port/-block/-top`                 | error                              | name does not resolve                                                  |
| `elab.duplicate-ref/-net/-port/-block`, `elab.port-bound-twice` | error                              | declared twice (a refdes: anywhere in the project's blocks)            |
| `ref.reserved`                                                  | error                              | a block declares a refdes reserved for a reused block's extra copy     |
| `elab.pin-multiple-nets`                                        | error                              | pin on two nets (a short)                                              |
| `elab.nc-connected`                                             | error                              | pin named by `nc` is on a net                                          |
| `elab.unbound-port`, `elab.bad-generic`, `elab.recursive-use`   | error                              |                                                                        |
| `erc.unconnected-pin`                                           | error for `power_in`, else warning | pin on no net that must not be open                                    |
| `erc.output-conflict`                                           | error                              | outputs of two parts on one net                                        |
| `erc.unsourced-power`                                           | error                              | `power_in` pins, no `power_out`, no `source`, and not ground           |
| `erc.single-pin-net`, `erc.undriven-input`, `erc.unused-port`   | warning                            | `undriven-input`: only inputs on the net, and no `source`              |
| `erc.no-pull`                                                   | warning                            | open-collector (or open-emitter) output with no resistor or `source`   |
| `erc.nc-pin-connected`                                          | warning                            | a pin of type `nc` (datasheet no-connect) is on a net                  |
| `erc.power-out-on-ground`                                       | warning                            | a `power_out` pin on a ground net: a short, unless a virtual ground    |
| `elab.unused-block`, `elab.attr-conflict`, `waive.unused`       | warning                            |                                                                        |
| `patch.error`                                                   | error                              | patch rejected; nothing was applied                                    |
| `layout.connectivity`, `layout.failed`                          | error                              | auto-layout bug: the drawing does not match the design                 |
| `part.footprint-pads`                                           | warning                            | record's pins and footprint pads differ (`MP` pads aside)              |
| `part.footprint-missing`, `kicad.no-footprint`                  | warning                            | KiCad has no such footprint; a part has no footprint                   |
| `part.format`                                                   | warning                            | a record in use has a field the engine cannot read                     |
| `part.schema`, `part.yaml`                                      | warning                            | a library file is unusable; a design using it gets `elab.unknown-part` |
| `part.duplicate-id`                                             | warning                            | two records in one library layer share an id; the later file is used   |
| `kicad.symbol-fallback`                                         | warning                            | a record's `kicad_symbol` does not fit; a symbol was generated         |
| `part.draft`                                                    | warning                            | a KiCad import draft record is in use; complete or replace it          |
| `part.overvoltage`                                              | error                              | a pin's `vmax` is below its net's voltage                              |
| `part.cap-voltage`                                              | error over rating, else warning    | capacitor rated below the voltage across it, or under derating         |
| `part.cap-polarity`                                             | error                              | a polarized capacitor's `+` is certainly below its `-`                 |
| `part.requirement`                                              | warning                            | a datasheet requirement with a check is not met                        |
| `context.temperature`                                           | warning                            | part outside context's temperature range                               |
| `context.unknown-connector`, `context.invalid`                  | warning                            | interface names no part; the design context is malformed               |
| `project.config`                                                | error                              | project file is not YAML or has no `name`; nothing else is checked     |
