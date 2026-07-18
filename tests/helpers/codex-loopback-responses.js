'use strict';

const crypto = require('node:crypto');
const http = require('node:http');

const MAX_REQUEST_BYTES = 1024 * 1024;

function compactResponse(fixture, status, output, usage) {
  return {
    id: fixture.response_id,
    object: 'response',
    created_at: 0,
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    max_tool_calls: null,
    model: fixture.model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    prompt_cache_key: null,
    reasoning: { effort: null, summary: null },
    safety_identifier: null,
    service_tier: 'default',
    store: false,
    temperature: null,
    text: { format: { type: 'text' }, verbosity: 'medium' },
    tool_choice: 'auto',
    tools: [],
    top_logprobs: 0,
    top_p: null,
    truncation: 'disabled',
    usage,
    user: null,
    metadata: {},
  };
}

function outputPart(fixture, text = '') {
  return { type: 'output_text', annotations: [], logprobs: [], text };
}

function outputMessage(fixture, status, content) {
  return {
    id: fixture.message_id,
    type: 'message',
    status,
    role: 'assistant',
    content,
  };
}

function buildResponsesEvents(fixture) {
  const inProgress = compactResponse(fixture, 'in_progress', [], null);
  const completedPart = outputPart(fixture, fixture.response_text);
  const completedMessage = outputMessage(fixture, 'completed', [completedPart]);
  const completed = compactResponse(fixture, 'completed', [completedMessage], {
    input_tokens: 1,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 2,
  });

  return [
    { event: 'response.created', data: { type: 'response.created', sequence_number: 0, response: inProgress } },
    { event: 'response.in_progress', data: { type: 'response.in_progress', sequence_number: 1, response: inProgress } },
    {
      event: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        sequence_number: 2,
        output_index: 0,
        item: outputMessage(fixture, 'in_progress', []),
      },
    },
    {
      event: 'response.content_part.added',
      data: {
        type: 'response.content_part.added',
        sequence_number: 3,
        item_id: fixture.message_id,
        output_index: 0,
        content_index: 0,
        part: outputPart(fixture),
      },
    },
    {
      event: 'response.output_text.delta',
      data: {
        type: 'response.output_text.delta',
        sequence_number: 4,
        item_id: fixture.message_id,
        output_index: 0,
        content_index: 0,
        delta: fixture.response_text,
        logprobs: [],
      },
    },
    {
      event: 'response.output_text.done',
      data: {
        type: 'response.output_text.done',
        sequence_number: 5,
        item_id: fixture.message_id,
        output_index: 0,
        content_index: 0,
        text: fixture.response_text,
        logprobs: [],
      },
    },
    {
      event: 'response.content_part.done',
      data: {
        type: 'response.content_part.done',
        sequence_number: 6,
        item_id: fixture.message_id,
        output_index: 0,
        content_index: 0,
        part: completedPart,
      },
    },
    {
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        sequence_number: 7,
        output_index: 0,
        item: completedMessage,
      },
    },
    { event: 'response.completed', data: { type: 'response.completed', sequence_number: 8, response: completed } },
  ];
}

function serializeEvents(events) {
  return events.map(({ event, data }) => (
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  )).join('');
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function startLoopbackResponsesServer(options) {
  const { fixture, expectedRequestCount, beforeResponse } = options || {};
  if (!fixture || !Number.isInteger(expectedRequestCount) || expectedRequestCount < 0) {
    throw new TypeError('invalid loopback server options');
  }
  const requests = [];
  const sockets = new Set();
  let protocolFailure = null;

  const server = http.createServer((request, response) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        overflow = true;
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', (error) => {
      if (!overflow) protocolFailure ||= error;
    });
    request.on('end', async () => {
      if (overflow) return;
      const bodyBytes = Buffer.concat(chunks);
      let body;
      try {
        body = JSON.parse(bodyBytes.toString('utf8'));
      } catch {
        body = null;
      }
      const expectedHost = `127.0.0.1:${server.address().port}`;
      const contentType = String(request.headers['content-type'] || '');
      const authorization = String(request.headers.authorization || '');
      const invariants = {
        method: request.method === fixture.request.method,
        path: request.url === fixture.request.path,
        host: request.headers.host === expectedHost,
        content_type: /^application\/json(?:\s*;.*)?$/i.test(contentType),
        authorization_public: authorization === `Bearer ${fixture.public_bearer}`,
        model: body?.model === fixture.model,
        stream: body?.stream === true,
        input_array: Array.isArray(body?.input),
        store_not_true: body?.store !== true,
      };
      const receipt = {
        ...invariants,
        body_sha256: sha256(bodyBytes),
        request_number: requests.length + 1,
      };
      requests.push(receipt);
      if (requests.length > expectedRequestCount
          || Object.values(invariants).some((value) => value !== true)) {
        protocolFailure ||= new Error('LOOPBACK_REQUEST_CONTRACT');
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
        response.end('request rejected\n');
        return;
      }
      try {
        if (beforeResponse) await beforeResponse(receipt);
      } catch (error) {
        protocolFailure ||= error;
        response.writeHead(409, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
        response.end('precondition rejected\n');
        return;
      }
      const payload = serializeEvents(buildResponsesEvents(fixture));
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'close',
      });
      response.end(payload);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const close = async () => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, 2000);
      timer.unref?.();
      server.close((error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
    for (const socket of sockets) socket.destroy();
    if (protocolFailure) throw protocolFailure;
    if (requests.length !== expectedRequestCount) {
      throw new Error(`LOOPBACK_REQUEST_COUNT:${requests.length}:${expectedRequestCount}`);
    }
  };
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    port: address.port,
    requests,
    close,
  };
}

module.exports = {
  MAX_REQUEST_BYTES,
  buildResponsesEvents,
  startLoopbackResponsesServer,
};
