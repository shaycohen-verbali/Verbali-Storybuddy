import { getRuntimeEvents } from './_lib/geminiServer.js';

const send = (res, status, data) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
};

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return send(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = req.method === 'POST'
      ? (typeof req.body === 'string' ? JSON.parse(req.body) : req.body)
      : req.query;
    const events = getRuntimeEvents({
      bookId: body?.book_id || body?.bookId,
      qaPlanId: body?.qa_plan_id || body?.qaPlanId,
      limit: body?.limit
    });

    return send(res, 200, {
      count: events.length,
      events
    });
  } catch (error) {
    return send(res, 500, {
      error: error?.message || 'runtime events failed'
    });
  }
}
