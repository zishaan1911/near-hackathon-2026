# System architecture notes

Read this before planning large changes.

- **Contract:** `contracts/near/gasx` (Rust). Live at `gasx.testnet`; collateral `tusdc.gasx.testnet`. One current market; `roll_market` is callable by the publisher.
- **API:** `server/` (Fastify). Vercel runs the esbuild bundle `api/index.js`, which is **committed**. After any server change run `npm --prefix server run build:vercel`, or the deploy ships old code.
- **AI:** `api/ai.py` (stateless, slim `requirements.txt`). `vercel.json` needs `"framework": null` or Vercel treats the repo as a FastAPI app.
- **Compute Index:** `server/src/compute/`, methodology in `docs/compute-index.md`. Matched quotes: every quote is compared only with its own base in `base.ts`. Adding a venue or product needs a new methodology version and `snapshotCompute.ts --write-base`.
- **Frontend:** `frontend/src/main.tsx` lazy-loads `MainApp` (wallets, needs `polyfills.ts`) and `compute/ComputeExperience` (`/compute`). Compute CSS is scoped under `.cx` in `compute/compute.css`.
- **Images:** `frontend/public/img/compute/`, attribution in `frontend/src/lib/imageCredits.json`. Every image needs an entry; the credits section renders from it. CC BY/BY-SA require attribution.
- **Windows paths:** the session folder path is too long for node tools. Use `subst G: <parent of repo>`, so the repo is `G:\near-hackathon-2026`. `server/node_modules/@gasx/near-adapter` is a junction to that exact path, so mapping G: to the repo itself breaks the build. Rust needs the GNU toolchain plus `AWS_LC_SYS_PREBUILT_NASM=1`.
