import { runTurnPipeline } from './_lib/geminiServer.js';

const send = (res, status, data) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const payloadBytes = Buffer.byteLength(JSON.stringify(body || {}), 'utf8');

    if (!body?.audioBase64 || !body.mimeType || !body.storyBrief) {
      return send(res, 400, { error: 'audioBase64, mimeType, and storyBrief are required' });
    }

    const result = await runTurnPipeline(
      body.audioBase64,
      body.mimeType,
      body.storyBrief,
      body.storyFacts || null,
      body.artStyle,
      body.stylePrimer || [],
      body.styleReferences || [],
      body.history || []
    );

    return send(res, 200, {
      ...result,
      payloadBytes
    });
  } catch (error) {
    return send(res, 500, {
      error: error?.message || 'turn failed'
    });
  }
}
