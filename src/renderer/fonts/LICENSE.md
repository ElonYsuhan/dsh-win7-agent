# 内置字体与许可

本目录下的 woff2 随安装包一起分发，**不安装、不替换 Windows 系统字体**。
三款字体均为 SIL Open Font License 1.1，允许随软件分发（含商业分发），
条件是保留版权声明与许可全文（即本文件），且不得单独售卖字体本身。

| 文件 | 字体 | 字重 | 用途 | 来源 |
| --- | --- | --- | --- | --- |
| `inter-400/500/600.woff2` | Inter | 400 / 500 / 600 | 拉丁与数字 | `@fontsource/inter` 5.x 的 `latin` 子集 |
| `noto-sans-sc-400/600.woff2` | Noto Sans SC（思源黑体） | 400 / 600 | 中文 | `@fontsource/noto-sans-sc` 5.x 的 `chinese-simplified` 子集 |
| `jetbrains-mono-400.woff2` | JetBrains Mono | 400 | 代码、路径、标识 | `@fontsource/jetbrains-mono` 5.x 的 `latin` 子集 |

## 为什么用子集

- 中文整包单个字重 8MB 以上，这里用常用简体子集（约 1.1MB/字重），
  6 个文件合计约 2.3MB。
- 子集里没有的生僻字会按 `typography.css` 的 `--font-ui` 回退链落到系统的
  微软雅黑（Win7 有 `Microsoft YaHei`，Win8+ 另有 `Microsoft YaHei UI`），
  不会出现方框。

## 版权声明

- Inter：Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)
- Noto Sans SC：Copyright Google Inc. (https://github.com/notofonts/noto-cjk)；
  与 Adobe 的 Source Han Sans（思源黑体）是同一设计的不同发行命名。
- JetBrains Mono：Copyright 2020 The JetBrains Mono Project Authors
  (https://github.com/JetBrains/JetBrainsMono)

## 许可全文

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
