# Examples

[`edit-pack.example.json`](edit-pack.example.json) is a worked template that
exercises every renderer feature in one pack:

| Feature | Where |
|---|---|
| **Cut** | the gap between the intro's `end` (18.0) and the next `start` (24.0) drops a fumbled retake |
| **Zoom punch-in** | `"zoom": 1.14` on the second segment |
| **Roll-switch + audio bed** | video cuts to `diagram` while `audio: "screen"` keeps the narration unbroken |
| **Image B-roll** | the `diagram` source has `"image": true` — held as a still for its segment |
| **Picture-in-picture** | the camera dropped into the bottom-right over the diagram |
| **Caption** | `"style": "plain"` — a neutral burned-in caption (`pos` places it) |
| **Warm audio** | `output.audioFilter` — gentle lift + limiter, nothing more |

It points at placeholder paths (`recordings/camera.mp4`, etc.). Drop your own
two-roll recording and a diagram image at those paths, then:

```bash
node ../skills/edator/scripts/render.js edit-pack.example.json --dry-run   # print the ffmpeg plan
node ../skills/edator/scripts/render.js edit-pack.example.json             # render to ./out/demo.mp4
```

The full field-by-field spec is in
[`../skills/edator/references/edit-pack.schema.json`](../skills/edator/references/edit-pack.schema.json).
