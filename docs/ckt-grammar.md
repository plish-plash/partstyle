# .ckt grammar reference

One statement per line. `#` starts a comment. Nothing has coordinates.

```
block NAME "description"                 # first statement; one block per file
port  NAME : KIND                        # KIND: power_in power_out ground input output bidir passive
part  REF lib:ID            [@ intent]   # a record from the part library
part  REF FN(arg, ...)      [@ intent]   # generic, resolved to an MPN at BOM time
net   NAME : PINREF... [-> port NAME] [{key: value, ...}] [@ intent]
use   BLOCK as INST         [@ intent]   # instantiate another block
waive SUBJECT [CODE] "reason"            # suppress a validation issue
```

- **Names** are any run of characters without whitespace or `: { } ( ) , " @ #`, so `+12V`
  and `VINA+` are fine. Refdes, net, port and instance names must not contain `.` or `/`.
- **PINREF** is `REF.PIN` or `INST.PORT`. `PIN` is a pin number (`C1.1`, `U4.22`) or a pin name
  (`U1.OUT`). A name shared by several pins (`U4.GND`) connects all of them.
- A pin may appear in only one net. List every pin of a net on its one line.
- **`-> port NAME`** exports the net as one of the block's declared ports. Each declared port
  must be bound to exactly one net. In the parent, `INST.PORT` joins that net to a parent net.
- **`@ intent`** runs to the end of the line. It records why a part or net is there.
- **Net attributes** are free text values: `{voltage: 12V ±10%, source: J1 through D1}`.
  `source` tells ERC that a rail with no `power_out` pin is supplied from elsewhere.
- **Generics**: `res(value, [tol], [pkg])`, `cap(value, [voltage], [dielectric], [pkg])`,
  `ind(value, [current], [pkg])` with pins 1, 2; `led(color, [pkg])` and `diode(kind, [pkg])`
  with pins K (1), A (2). Values use SI prefixes: `330n`, `4k7`, `10uF`, `1.5A`.
- **Waivers**: SUBJECT is a refdes, pinref or net, relative to the block. `*` matches anything
  (`U4.PD*`). CODE limits the waiver to one issue code. Unused waivers are reported.

## Hierarchy

```
block main
use power as PWR
use mcu   as MCU
net +3V3 : PWR.+3V3 MCU.+3V3
net GND  : PWR.GND MCU.GND
```

Parts inside an instance get path names (`PWR/U1`), and so do nets that are not joined to a
parent net (`PWR/VIN_RAW`). The top block is `top` in `project.toml`, which defaults to `main`.

## Patches (`apply`)

A patch is a batch of edits, one per line, applied all-or-nothing:

```
in power                          # block to edit; optional if the project has one block
+ part C13 cap(47u, 25V) @ bulk   # add a statement (error if the key exists)
= part U2 lib:MCP1700T-3302E_TT   # replace the statement with the same kind and key
- part D2                         # remove; also drops D2's pins from nets (part|net|port|use|waive)
net +12V += C13.1 C13.2           # connect pins to an existing net
net GND  -= C3.2                  # disconnect pins
rename part C13 C20               # also rewrites pinrefs and waivers (part|use|net)
in sensor_ref                     # a new block: its first edit must be
+ block sensor_ref "2.5 V ref"    #   '+ block NAME', creating circuit/NAME.ckt
```

Keys: part REF, net NAME, port NAME, use INST, waive SUBJECT. Edited lines are rewritten in
canonical spacing; untouched lines keep their formatting. The reply lists the edits and only
the issues they added or resolved. Use `dry_run` to preview.

## Issue codes

| Code                                                            | Severity                           | Meaning                                                      |
| --------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| `parse.syntax`, `parse.missing-block`                           | error                              | malformed statement                                          |
| `elab.unknown-part/-pin/-ref/-port/-block/-top`                 | error                              | name does not resolve                                        |
| `elab.duplicate-ref/-net/-port/-block`, `elab.port-bound-twice` | error                              | declared twice                                               |
| `elab.pin-multiple-nets`                                        | error                              | pin on two nets (a short)                                    |
| `elab.unbound-port`, `elab.bad-generic`, `elab.recursive-use`   | error                              |                                                              |
| `erc.unconnected-pin`                                           | error for `power_in`, else warning | pin on no net (`nc` pins exempt)                             |
| `erc.output-conflict`                                           | error                              | outputs of two parts on one net                              |
| `erc.unsourced-power`                                           | error                              | `power_in` pins, no `power_out`, no `source`, no ground port |
| `erc.single-pin-net`, `erc.undriven-input`, `erc.unused-port`   | warning                            |                                                              |
| `elab.unused-block`, `elab.attr-conflict`, `waive.unused`       | warning                            |                                                              |
| `patch.error`                                                   | error                              | patch rejected; nothing was applied                          |
