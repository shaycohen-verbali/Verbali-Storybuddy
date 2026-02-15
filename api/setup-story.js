import { setupStoryPack } from './_lib/geminiServer.js';

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

    if (!body?.storyFile?.data || !body.storyFile.mimeType) {
      return send(res, 400, { error: 'storyFile is required' });
    }

    const result = await setupStoryPack(body.storyFile, body.styleImages || []);
    return send(res, 200, {
      ...result,
      payloadBytes
    });
  } catch (error) {
    return send(res, 500, {
      error: error?.message || 'setup-story failed'
    });
  }
}
