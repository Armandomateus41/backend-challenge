import { InvariantViolationError } from './shared/errors';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt: Date | undefined;
}

/**
 * Deduplication record of a consumed message, unique per (consumerName, messageId). It is written
 * in the same SQL transaction as the financial effect, so its presence proves the effect committed.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (!props.messageId || !props.consumerName) {
      throw new InvariantViolationError('Inbox messages require messageId and consumerName');
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this._processedAt) {
      throw new InvariantViolationError(`Inbox message ${this.messageId} already processed`);
    }
    this._processedAt = at;
  }
}
