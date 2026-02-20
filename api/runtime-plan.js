import { createRuntimeQaPlan, loadBookPackageRuntime } from './_lib/geminiServer.js';

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
    const bookId = body?.book_id || body?.bookId;
    const questionText = body?.question_text || body?.questionText;
    const qaReadyPackage = body?.qa_ready_package || body?.qaReadyPackage || null;
    const styleReferences = body?.style_references || body?.styleReferences || [];

    if (!bookId || !questionText) {
      return send(res, 400, { error: 'book_id and question_text are required' });
    }

    if (qaReadyPackage) {
      loadBookPackageRuntime({
        bookId,
        qaReadyPackage,
        styleReferences,
        forceReload: Boolean(body?.force_reload || body?.forceReload)
      });
    }

    const plan = await createRuntimeQaPlan({
      bookId,
      questionText,
      difficulty: body?.difficulty || 'easy',
      qaReadyPackage: null,
      styleReferences: []
    });

    return send(res, 200, {
      qa_plan_id: plan.qaPlanId,
      session_id: plan.sessionId,
      book_id: plan.bookId,
      question_text: plan.questionText,
      choices: plan.choices.map((choice) => ({
        choice_id: choice.choiceId,
        answer_text: choice.answerText
      })),
      internal: {
        correct_choice_id: plan.internal.correctChoiceId
      },
      debug: plan.debug
    });
  } catch (error) {
    return send(res, 500, {
      error: error?.message || 'runtime plan failed'
    });
  }
}
