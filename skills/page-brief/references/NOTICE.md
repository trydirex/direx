# Credit

The `intent` gap and the templated `meta` check in `gaps.md` take their ideas from claude-seo
(https://github.com/AgricIDaniel/claude-seo) at commit `6be93f45064ffbadced572b5d5c95f55fd263af0`:

- `agents/seo-sxo.md` and `skills/seo-sxo/references/page-type-taxonomy.md`: a page-type mismatch
  is the first finding, and the list of page kinds. Its SXO concept is credited there to Florian
  Schmitz.
- `agents/seo-content.md`: a description that repeats its title and ends with a stock call to
  action is a sign of templated metadata; freshness signals.

No text was copied. claude-seo reads live search results, runs Python scripts and gives scores;
this skill does none of that. claude-seo is released under the MIT licence:

```
MIT License

Copyright (c) 2026 agricidaniel

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
