import { type Message } from '@aws-sdk/client-sqs';

/** Awaits a promise that must reject and returns the rejection reason. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

/** Event id carried in the body of a message published from the outbox. */
export function eventIdOf(message: Message): string {
  const body = JSON.parse(message.Body ?? '{}') as { eventId?: unknown };
  if (typeof body.eventId !== 'string') {
    throw new Error('message body has no eventId');
  }
  return body.eventId;
}
