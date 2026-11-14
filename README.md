# Patrol

A Scrypted plugin that makes **one virtual camera out of several**. A patrol camera shows its member cameras in turn and cuts to the camera where something happens. Its motion, occupancy and sensors follow that camera, so anything that records or notifies on one camera works with the whole set.

One use: a home or a family where only one camera can record (an iCloud plan with a single HomeKit Secure Video camera, say). The patrol is that camera, and it records whichever member has the event.

## How it works

- **Rotation.** While nothing happens, each member is on screen for *Rotation* seconds, in the order of the list. A member whose stream fails is skipped for a minute. The camera that comes next starts decoding 4 s before its turn, so the switch shows it in the same frame; each slot is counted from when its picture appears.
- **Events.** A member has an event while any of its configured triggers is on:
  - its own motion sensor,
  - its own occupancy sensor,
  - an object detection of one of the configured classes, which counts for *Detection hold* seconds,
  - any extra sensors assigned to it (occupancy, motion or binary sensors of any plugin).

  The patrol cuts to the camera with the newest event right away. The new camera's first frame must arrive before the old one is dropped, so the picture never goes black between cameras.
- **Several events at once.** The camera on screen keeps it for at least *Minimum event time*, after which a newer event elsewhere takes over. When an event ends, another live event gets the screen at once. Otherwise the screen stays for *Hold after event*, then rotation resumes. One event keeps the screen at most *Maximum event time*: a sensor that stays on, such as a parked car, has to go off and on again to get the screen back. A trigger that comes back within *Re-arm after* of going off continues the same event, so a sensor that drops and re-raises during one activity cannot stretch it past the maximum.
- **Outputs.** The patrol's own sensors follow only the event camera on screen, once the switch to it is complete. Otherwise they are all off.
  - **Motion** is on while that camera has its event.
  - **Occupancy** copies that camera's own occupancy sensor.
  - **Object detection** events are forwarded from that camera.
  - **Child sensors:** each extra sensor gives the patrol a child sensor named `<patrol> <label>`. The label is the sensor's name without the camera's name in front, so "Garden Vehicle Presence" on camera "Garden" becomes "Patrol Vehicle Presence". A child is on while the event camera on screen has a sensor with that label on.
  - **Snapshots** come from the camera on screen.

## The stream

The patrol is a camera like any other. Its stream goes through Scrypted's usual extensions (Rebroadcast, HomeKit, and so on).

- One decoder per camera on screen reads that member's stream through the member's own extensions. *Source stream* picks which of its streams is used, by role; low resolution by default, so a rebroadcast substream is decoded and not a 4K main stream.
- The decoder letterboxes the picture into the output size. The plugin paces the newest frame into **one** long-running encoder.
- The encoder only ever sees one continuous stream: one size, one frame rate, steady timestamps. A camera switch is a scene change to it.
- The output is H.264 **Main**, level 3.1 or higher, no B-frames, SPS/PPS repeated on every keyframe and a keyframe every second. It is served as MPEG-TS on a local port. Strict live players (HomeKit) accept this as it is, so nothing downstream needs to encode it again.
- **Cost:** one decode of the camera on screen plus one encode at the output size. At 960x540 and 7 fps that is roughly a tenth of one CPU core with software x264. The encoder runs while something reads the stream (Rebroadcast's prebuffer keeps it on), and stops 30 s after the last reader leaves.

## Settings

| Group | Setting | Default |
|---|---|---|
| Cameras | Cameras (rotation order) | none |
| Triggers | Camera motion / Camera occupancy | on / on |
| | Detection classes (comma separated) | none |
| | Detection hold | 10 s |
| | Extra sensors, per camera | none |
| Timing | Rotation (0 = none) | 10 s |
| | Minimum event time | 8 s |
| | Maximum event time | 120 s |
| | Hold after event | 5 s |
| | Re-arm after | 30 s |
| Output | Size | 960x540 |
| | Frame rate | 7 |
| | Bitrate | 1200 kbit/s |
| | Source stream | low-resolution |
| | Camera name on screen (top left) | off |
| | Countdown to the next camera (bottom left, "cucina in 7s") | off |
| | Name pattern / Name replacement (regex for the names on screen, e.g. `^villa_\d+_` and nothing) | none |
| | Font file | none (fontconfig) |

Text on screen uses ffmpeg's `drawtext`: the camera name is drawn by each camera's decoder, the countdown by the encoder from a file the plugin rewrites once a second. Whether this ffmpeg can draw text with the configured font (or with fontconfig, when none is set) is checked once with a one-frame run; when it cannot, the text is left out and the stream is unaffected. The countdown is blank while a switch is still on its way.

## Known limits

- **Pre-event video.** A recorder that keeps a few seconds before motion (HomeKit Secure Video) records the camera that was on screen before the cut for those seconds.
- **No audio.**
- **Child sensors keep their first name.** They are named once; renaming the patrol does not rename them.

## Build and test

```
npm install
npm test                 # unit tests: rotation and event rules, frames, ffmpeg arguments, triggers
npm run build            # plugin bundle in out/
npx scrypted-deploy <scrypted-host>:10443
```

`tools/pipeline-check.ts` runs the real pipeline locally with two synthetic cameras and probes the output (needs ffmpeg with libx264):

```
npx tsc -p tsconfig.test.json && node out-test/tools/pipeline-check.js /tmp/patrol-check.ts
```

## License

Apache-2.0, see [LICENSE](LICENSE).
