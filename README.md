<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1L1LJPvu9R52bCQdeV7CAiqejysxai_DY

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) for the backend API routes.
3. For Replicate image generation, set `REPLICATE_API_TOKEN`.
4. Optional: set `REPLICATE_IMAGE_MODEL` (default: `google/nano-banana-pro:d71e2df08d6ef4c4fb6d3773e9e557de6312e04444940dbb81fd73366ed83941`).
5. Optional fallback (when Replicate token is not set): `GEMINI_IMAGE_MODEL` (default: `gemini-2.5-flash-image`).
6. Optional (legacy client-only mode): set `VITE_GEMINI_API_KEY` and `VITE_USE_BACKEND_PIPELINE=false`.
7. Optional (legacy client-only mode): set `VITE_IMAGE_MODEL` (default: `gemini-2.5-flash-image`).
8. Run the app:
   `npm run dev`
