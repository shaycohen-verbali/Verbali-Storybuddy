import { loadBookPackageRuntime } from './_lib/geminiServer.js';

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
    const qaReadyPackage = body?.qa_ready_package || body?.qaReadyPackage || null;
    const styleReferences = body?.style_references || body?.styleReferences || [];

    if (!bookId || !qaReadyPackage) {
      return send(res, 400, { error: 'book_id and qa_ready_package are required' });
    }

    const context = loadBookPackageRuntime({
      bookId,
      qaReadyPackage,
      styleReferences,
      forceReload: Boolean(body?.force_reload || body?.forceReload)
    });

    return send(res, 200, {
      book_id: context.bookId,
      session_id: context.sessionId,
      book_package_hash: context.bookPackageHash,
      text_quality: context.qaReadyManifest?.textQuality || context.qaReadyPackage?.manifest?.textQuality || 'mixed',
      entity_count: context.entityRecords.length,
      style_ref_count: context.styleReferences.length,
      style_ref_image_id_count: context.styleBible?.styleReferenceImageIds?.length || 0
    });
  } catch (error) {
    return send(res, 500, {
      error: error?.message || 'runtime load failed'
    });
  }
}
