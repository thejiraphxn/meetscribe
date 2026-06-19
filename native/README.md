# SystemAudioTap — macOS system-audio helper

Captures system (loopback) audio via **ScreenCaptureKit** and streams it to
`stdout` as raw **Float32 PCM, mono, 16 kHz** for the MeetScribe Python sidecar.

## Build

```bash
swiftc -O SystemAudioTap.swift -o systemtap \
  -framework ScreenCaptureKit -framework AVFoundation
```

Requires **macOS 13+**. On first run macOS prompts for **Screen Recording**
permission (system-audio capture rides on the screen-recording entitlement).

## Output protocol

| Stream  | Content                                                              |
| ------- | ------------------------------------------------------------------- |
| stdout  | little-endian Float32 samples, mono, 16 kHz, no header (pure PCM)    |
| stderr  | diagnostics + fatal errors                                          |
| exit 0  | clean shutdown (SIGINT/SIGTERM, or downstream pipe closed)          |
| exit 1  | stream error (`stream(_:didStopWithError:)`)                        |

The sidecar reads stdout as `np.frombuffer(chunk, dtype=np.float32)`.

## Run

```bash
./systemtap > /tmp/system.pcm   # Ctrl-C to stop
```

## Known toolchain issue (Command Line Tools 16.4)

If `swiftc` fails with:

```
error: redefinition of module 'SwiftBridging'
```

this is a **CLT 16.4 regression**: a stale `module.modulemap` duplicates the
current `bridging.modulemap`. Two non-destructive fixes:

**A. Install full Xcode** (recommended) and point the toolchain at it:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

**B. Retire the stale duplicate** (back it up first, requires sudo):

```bash
sudo mv /Library/Developer/CommandLineTools/usr/include/swift/module.modulemap \
        /Library/Developer/CommandLineTools/usr/include/swift/module.modulemap.bak
```

The two files are byte-identical apart from the copyright year; `module.modulemap`
(2023) is the leftover, `bridging.modulemap` (2024) is the live one. Either fix
lets the build above succeed. After fixing, re-run the `swiftc` command.
