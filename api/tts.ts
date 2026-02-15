import { synthesizeSpeech } from './_lib/geminiServer.js';

const send = (res: any, status: number, data: unknown) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body?.text || typeof body.text !== 'string') {
      return send(res, 400, { error: 'text is required' });
    }

    const audio = await synthesizeSpeech(body.text);
    return send(res, 200, { audio });
  } catch (error: any) {
    return send(res, 500, {
      error: error?.message || 'tts failed'
    });
  }
}
