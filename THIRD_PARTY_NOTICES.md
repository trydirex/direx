# Third-party notices

Direx is licensed under the AGPL-3.0-only (see [LICENSE](LICENSE)). Two of its files were written
from code in other projects that was published under the MIT License. That license asks for its
copyright notice and permission notice to travel with the code, so both are kept here.

## Paperclip

- Direx file: `apps/api/src/modules/models/adapters/runtime/setup-token-parse.ts`
- Written from: `packages/adapters/claude-local/src/server/setup-token-parse.ts` in
  https://github.com/paperclipai/paperclip, as it stood on 2026-10-30 (last changed in commit
  `c1c46f1e4eb22aaa08c4a9567fafe905db5a2284`)
- What Direx changed: it accepts only the exact shapes the CLI prints, and never logs or throws
  with what it read.

```
MIT License

Copyright (c) 2025 Paperclip AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Harvey

- Direx file: `apps/api/src/modules/outreach/domain/reply-languages.ts` (the English opt-out
  phrases and the bare replies)
- Adapted from: `OPT_OUT_PATTERNS` and `BARE_OPT_OUTS` in https://github.com/ethanplusai/harvey
- When: the list is in Direx's first commit, dated 2026-11-02. Harvey was MIT up to and including
  its commit `8f3ad28583c815142c3ed9b5194d432b2d8c4ee6` (releases up to 0.3.x). The next commit,
  `574fb61d4c` on 2026-11-03, made the project (now Sellbird) AGPL-3.0-only from 0.4.0, and
  nothing from those later versions is in Direx or may be copied into it.
- What Direx changed: the lists for eight more languages are Direx's own, and phrases that could
  mean something else were left out.

```
MIT License

Copyright (c) 2026 Ethan Rogers

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## In the server image

The image built from `deploy/docker/Dockerfile` also carries programs that Direx runs but does not
link to or change. Each keeps its own license, and each is installed from the source named here.

| Program | License | Where it comes from |
|---|---|---|
| whisper.cpp (`whisper-cli`) | MIT, Copyright (c) 2023-2026 The ggml authors; its license file is at `/usr/share/licenses/whisper.cpp/LICENSE` in the image | Built from https://github.com/ggml-org/whisper.cpp at the tag in the Dockerfile |
| FFmpeg | GPL and LGPL, as Debian builds it | The Debian `ffmpeg` package; its source is at https://packages.debian.org/source/trixie/ffmpeg |
| bubblewrap | LGPL-2.0-or-later | The Debian `bubblewrap` package |
| DejaVu fonts | Bitstream Vera and public-domain terms | The Debian `fonts-dejavu-core` package |
| Bun | MIT | The `oven/bun` base image |

Debian keeps each package's copyright file in the image under `/usr/share/doc/<package>/copyright`.
