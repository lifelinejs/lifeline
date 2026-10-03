# 📦 Lifeline

> _Command-line tool to manage Lifeline branches._

## 🌟 Highlights

- **One file describes every line:** A single `SUPPORT.yaml` lists your release lines (`3.x`, `2.x`, …) and their stage, so the lifecycle lives in version control next to the code it describes.
- **Lifecycles are enforced:** Lines only travel `indev` -> `as` -> `ls` -> `el`, and `lifeline check` shows each branch and its lifecycle.
- **A status table you can read at a glance:** `lifeline status` prints version, stage, branch, whether that branch really exists, the EOL date and the days remaining, or `--json` for anything scripted.
- **Backports in one command:** `lifeline backport <sha> --to v1.x` cherry-picks a commit from `devel` onto a support branch and opens the pull request, with a `[v1.x]`-prefixed title and a body recording where the fix came from. Refuses lines in development or End of Life, and asks for `--label security` or `--label critical` before it touches Life Support.

## ℹ️ Overview

Lifeline is a CLI to automate your git support branches. Instead of manually backporting or creating LTS branches, you can use Lifeline to do it in less than a second.

### ✍️ Authors

> **AI Disclosure:** AI was used in the development of Lifeline.

- **Main Developer:** [@kamixfox](https://github.com/kamixfox)

## 🚀 Usage

Quickly set up Lifeline for your repository:

```bash
lifeline init
```

And then verify it works:

```bash
lifeline status
```

## ⬇️ Installation

**Prerequisites:** Node.js v22.13.0 through v22.x, or v24 and later ([Download](https://nodejs.org/en/download)), and the `gh` CLI installed ([Download](https://cli.github.com/)).

---

Find bugs, or want to report a feature? [Open an issue](https://github.com/lifelinejs/lifeline/issues), and we'll get to fixing/adding it! If you'd rather implement them yourself, you can also [open a pull request](https://github.com/lifelinejs/lifeline/pulls). People like you make small OSS projects like these thrive!
