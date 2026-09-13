# Swarm

Living things, drawn as dots. A murmuration of starlings that wheels, folds, thins and thickens: thousands of dots moving as one shape. Canvas 2D, no dependencies, one script.

Third of the TonkaTuff libraries, after [Ephemeris](https://github.com/TonkaTuff/ephemeris) (the sky) and [Coriolis](https://github.com/TonkaTuff/coriolis) (the weather). The dots are sized the same way, so all three sit together on a page.

## Use it

```html
<script src="https://cdn.jsdelivr.net/gh/TonkaTuff/swarm@v0.1.0/dist/swarm.min.js"></script>
<canvas class="swarm" width="300" height="200" data-swarm-body="starlings"></canvas>
```

Every `canvas.swarm` on the page mounts itself. Height sets the size; a wider canvas gives the flock room to roam. Add canvases later with `Swarm.register()`. One thing at a time: `dist/<name>.min.js` is the core plus that one.

## Things

| Family | Name | What marks it out |
|---|---|---|
| Murmurations | `starlings` | the classic: a cloud that folds and pours |
| | `rome` | the winter roosts over the Tiber, the biggest of all |
| | `gretna` | the Scottish border, where the shapes get wildest |
| | `brighton` | over the old pier at dusk, small and quick |

## How it moves

Every bird keeps a fixed place in a ball. The ball wanders on a noisy path, its axes turn, it stretches along one and squashes along another, a shear folds it, and density waves roll through it. Nothing is remembered between frames: each one is a function of time, so a still frame, a loop and a scrub all work.

## Knobs

| attribute | value | what it does |
|---|---|---|
| `data-swarm-body` | name | one of the names above |
| `data-swarm-n` | number | how many birds at a 64px height, scaled up with size; 1800 by default |
| `data-swarm-reach` | number | the flock's size as a fraction of the height, 0.3 by default |
| `data-swarm-wave` | number | how strongly density waves roll through it, 1 by default |
| `data-swarm-tempo` | number | how fast it all happens, 1 by default |
| `data-swarm-ink` | `1` | monochrome dots that follow the page theme |
| `data-swarm-lite` | `1` | half the dots |
| `data-swarm-ground` | `1` | a dusk sky behind |
| `data-swarm-glow` | `0` | no soft glow, just the dots on a clear canvas |

Any `data-swarm-<knob>` reaches the mode as `opts.knob`, numbers parsed. Colours come from CSS custom properties, inherited: `--swarm-cold`, `--swarm-mid`, `--swarm-hot` for far to near, `--swarm-glow` for the light behind.

## JavaScript

```js
Swarm.body('rome', ctx, 200, t, dark, { w: 400, ground: true });
Swarm.GROUPS;   // { Murmurations: [...] }
```

## Build

`npm run build` writes `dist/swarm.min.js` and one `dist/<name>.min.js` per thing. `tools/verify.html` and `tools/verify-min.html`, served over http, check every bundle draws pixel-identical to the source.

MIT.
