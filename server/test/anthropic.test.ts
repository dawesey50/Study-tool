/**
 * translate()'s handling of a bare connection failure.
 *
 * The Anthropic SDK's APIConnectionError always carries the fixed message
 * "Connection error." — the actual reason (DNS, TLS interception, a refused
 * connection) lives on `.cause` instead, exactly like a raw fetch failure
 * does for the other providers. Anthropic is the default provider for most
 * tasks, so translate() reporting only "Connection error." here would have
 * left the most commonly used provider with precisely the unhelpful message
 * describeFetchError was written to get rid of everywhere else.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { translate } from '../src/llm/providers/anthropic.js';

test('a bare connection failure reports its real cause, not just "Connection error."', () => {
  const cause = Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' });
  const apiError = new Anthropic.APIConnectionError({ cause });

  const translated = translate(apiError);

  assert.equal(translated.name, 'ProviderUnavailableError');
  assert.match(translated.message, /CERT_HAS_EXPIRED/);
  assert.match(translated.message, /certificate has expired/);
});

test('a bad request still surfaces as our own bug, unaffected by the cause handling', () => {
  const badRequest = Object.create(Anthropic.BadRequestError.prototype) as InstanceType<
    typeof Anthropic.BadRequestError
  >;
  Object.assign(badRequest, { message: 'schema is invalid', status: 400 });

  const translated = translate(badRequest);

  assert.equal(translated.name, 'ProviderRequestError');
  assert.equal(translated.message, 'schema is invalid');
});

test('a plain non-SDK error still reports its cause', () => {
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), {
    code: 'ENOTFOUND',
  });
  const bare = Object.assign(new TypeError('fetch failed'), { cause });

  const translated = translate(bare);

  assert.equal(translated.name, 'ProviderUnavailableError');
  assert.match(translated.message, /ENOTFOUND/);
});
