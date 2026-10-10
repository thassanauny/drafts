# Utility Desk Lite third-party notices

These packages are bundled locally. License texts are in [licenses/](licenses/). Their notices apply to the respective components.

| Package | Bundled version | Package license |
| --- | --- | --- |
| @ffmpeg/core | 0.12.10 | GPL-2.0-or-later |
| @ffmpeg/ffmpeg | 0.12.15 | MIT |
| @ffmpeg/util | 0.12.2 | MIT |
| @js-temporal/polyfill | 0.5.1 | ISC |
| jsbi | 4.3.2 | Apache-2.0 |
| fflate | 0.8.3 | MIT |
| pdf-lib | 1.17.1 | MIT |
| @cantoo/pdf-lib | 2.11.1 | MIT |
| culori | 4.0.2 | MIT |
| node-html-better-parser | 1.5.9 | MIT |
| html-entities | 2.6.0 | MIT |
| qrcode | 1.5.4 | MIT |
| dijkstrajs | 1.0.3 | MIT |
| tslib (PDF unlock worker) | 2.8.1 | 0BSD |
| @pdf-lib/fontkit | 1.1.1 | MIT |
| pako | 1.0.11 | MIT/Zlib |
| pdfjs-dist | 4.8.69 | Apache-2.0 |
| @pdf-lib/standard-fonts | 1.0.0 | MIT |
| @pdf-lib/upng | 1.0.1 | MIT |
| tslib | 1.14.1 | 0BSD |

## FFmpeg WebAssembly

The JavaScript wrapper is MIT-licensed. The unmodified @ffmpeg/core 0.12.10 binary is GPL-2.0-or-later. Its [GPL license text](licenses/ffmpeg-core-GPL-2.0.txt) and [wrapper license](licenses/ffmpeg-wrapper.txt) are included.

Source and build configuration: [ffmpeg.wasm v0.12.10](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10), including its [Dockerfile](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/v0.12.10/Dockerfile) and [build scripts](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10/build). The Dockerfile pins [FFmpeg n5.1.4](https://github.com/FFmpeg/FFmpeg/tree/n5.1.4) and identifies the component source repositories and revisions for x264, x265, libvpx, LAME, Ogg, Theora, Opus, Vorbis, zlib, WebP, FreeType, FriBidi, HarfBuzz and libass.

The app source, tests, and exact npm lockfile are included under `modules/utility-desk/` in the shared Sites repository, or `source/` in a standalone public distribution. The GPL designation above applies to the FFmpeg core; it is not a newly assigned license for Utility Desk Lite.

## PDF.js fonts and character maps

PDF.js is Apache-2.0. Font-specific notices are included at pdfjs/standard_fonts/LICENSE_FOXIT and pdfjs/standard_fonts/LICENSE_LIBERATION; character-map notices are at pdfjs/cmaps/LICENSE.

Document PDF output embeds subsets of the bundled Liberation Sans fonts, licensed under the SIL Open Font License 1.1. Fontkit is the [pdf-lib fork](https://github.com/Hopding/fontkit), declared MIT in its package and README. The package’s license/source reference is included in [licenses/fontkit-MIT.txt](licenses/fontkit-MIT.txt). Pako’s notices are included in [licenses/pako.txt](licenses/pako.txt).

## QR generation and PDF unlocking

QR generation uses [qrcode](https://github.com/soldair/node-qrcode) and dijkstrajs. PDF unlocking uses [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib), its vendored UPNG and standard fonts, culori, node-html-better-parser, html-entities and tslib 2.8.1. Their license texts are included in `licenses/`. These assets are bundled on the hosting origin; no external service receives QR contents, PDF files or passwords.
