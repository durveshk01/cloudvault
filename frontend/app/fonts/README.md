# Inter font

`Inter-latin-variable.woff2` is the existing Inter Latin font recovered from
CloudVault's previously built Android frontend. Its embedded metadata identifies
the Inter Project Authors and the SIL Open Font License. It supports weights
100 through 900. The license is included in `OFL.txt`.

SHA-256: `c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4`.

The root layout uses `next/font/local` so clean web and Android frontend builds
do not require Google Fonts access. Characters outside the Latin subset use the
browser's fallback font.
