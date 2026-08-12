# Replacing an Arduino Nano 33 IoT

Short answer: **plug the new board into the same USB hub port and flash the
firmware. No software configuration changes.**

That is by design, and it is worth knowing why, because the one thing that
*will* break it is using a different hub port.

## Why no configuration changes

Nothing in the system is keyed to a particular board. Everything that
identifies a segment is keyed to the **USB hub port** it is plugged into:

| Thing | Keyed to | Effect of a new board |
|---|---|---|
| `/dev/busduct-bus1` / `bus2` | hub port, via `deploy/udev/99-busduct-nano.rules` (`KERNELS=="1-1.N"`) | symlink follows the port, not the board |
| `BUSDUCT_UHUBCTL_BUS1` / `BUS2` | hub port (`1-1:2` / `1-1:1`) | unchanged |
| Flow `serial-port` config nodes | the symlinks above | unchanged |
| `cfg/modbus` bus `port` | the symlinks above | unchanged |

The udev rule deliberately does **not** match on the board's USB serial number
— only `KERNEL=="ttyACM*"` plus the hub port. That is what makes a swap a pure
hardware operation. (The serials recorded in that file are documentation of
what was fitted, not matching criteria.)

The Nano also holds **no per-board state of its own**. It is a Modbus *master*
that receives its entire job — slave list, register spans, baud, timeout —
from the Pi over serial on every update. A freshly flashed board knows nothing
and needs to know nothing; the Pi's silence watchdog hands it the job within
30 s of it going quiet.

> **The one hard constraint: same hub port.** Use a different port and both the
> symlink and the `uhubctl` recovery target are wrong — that segment will not
> be polled, and a COMM failure would power-cycle the *other* segment's Nano.
> If you must move it, update `deploy/udev/99-busduct-nano.rules` and
> `BUSDUCT_UHUBCTL_BUS*` together, and re-verify with `sudo uhubctl`.

## Procedure

### 1. Fit the board

Power down, swap the Nano into the **same hub port**, and move the RS-485 A/B
pair (and any ground/shield) to the new board.

### 2. Flash the firmware

The board arrives blank — this is the only step that is genuinely required.

**Stop Node-RED first.** Its `serial in`/`serial out` nodes hold the port open,
which will make the upload fail or hang:

```bash
sudo systemctl stop nodered
```

Dependencies (once per build machine):

- Board package: **Arduino SAMD Boards (32-bit ARM Cortex-M0+)**
- Libraries: **ArduinoJson**, **ModbusMaster**, **Adafruit SleepyDog Library**

With `arduino-cli` on the Pi. Note the sketch folder must be named for the
sketch, which `firmware/` is not, so copy it out first:

```bash
arduino-cli core install arduino:samd
arduino-cli lib install ArduinoJson ModbusMaster "Adafruit SleepyDog Library"

mkdir -p /tmp/Nano_IOT && cp firmware/Nano_IOT.ino /tmp/Nano_IOT/
arduino-cli compile --fqbn arduino:samd:nano_33_iot /tmp/Nano_IOT
arduino-cli upload -p /dev/busduct-bus2 --fqbn arduino:samd:nano_33_iot /tmp/Nano_IOT
```

Substitute the segment you are replacing. If the upload cannot find the port,
the board is probably not in bootloader mode — double-tap its reset button and
retry immediately, or use the raw device name that `ls -l /dev/busduct-bus2`
resolves to.

```bash
sudo systemctl start nodered
```

### 3. Verify

- **Debug sidebar**: the segment's job appears (`bus2 job out`, or `debug 4`
  for bus1) within ~30 s, and frames start arriving.
- **Diag page**: that segment's devices return to `Connected`. If they read
  **No Data**, nothing is being polled.
- **Active Alarms**: no `SYSTEM|…|COMM_FAILURE` for that segment.
- **The other segment never stops.** If it blipped, the board went into the
  wrong port.

## If you forget to flash it

The symptom is unambiguous, which is the point of the per-segment alarms: the
board enumerates (so the symlink appears and the serial node opens fine) but
never answers, so that segment raises its own `COMM_FAILURE` after 60 s, the
silence watchdog resends its job every 30 s to no effect, and USB recovery
power-cycles it three times before giving up and emailing. The *other* segment
keeps polling throughout.
