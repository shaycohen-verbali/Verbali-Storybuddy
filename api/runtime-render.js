import { renderRuntimeQaImages } from './_lib/geminiServer.js';

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
    const qaPlanId = body?.qa_plan_id || body?.qaPlanId;

    if (!qaPlanId) {
      return send(res, 400, { error: 'qa_plan_id is required' });
    }

    const result = await renderRuntimeQaImages({ qaPlanId });
    return send(res, 200, {
      qa_plan_id: result.qaPlanId,
      session_id: result.sessionId,
      book_id: result.bookId,
      question_text: result.questionText,
      images: result.images.map((item) => ({
        choice_id: item.choiceId,
        image_id: item.imageId,
        storage_uri: item.storageUri,
        image_data_url: item.imageDataUrl,
        error: item.error || null
      }))
    });
  } catch (error) {
    return send(res, 500, {
      error: error?.message || 'runtime render failed'
    });
  }
}
