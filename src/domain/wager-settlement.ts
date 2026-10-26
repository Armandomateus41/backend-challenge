import { FailureCode } from './failure-code';
import { LedgerDirection, type WalletLedgerEntry } from './ledger-entry';
import { InvariantViolationError } from './shared/errors';
import { type WagerTransaction, WagerTransactionStatus } from './wager-transaction';
import { type Wallet } from './wallet';

export interface ReferenceResolution {
  /** Transaction found by (providerId, referenceExternalTransactionId), if any. */
  transaction: WagerTransaction | undefined;
  /** True when a PROCESSED REFUND/ROLLBACK already targets the referenced transaction. */
  alreadyReversed: boolean;
}

export interface SettlementInput {
  transaction: WagerTransaction;
  /** Wallet loaded under the per-wallet lock. */
  wallet: Wallet;
  reference: ReferenceResolution | undefined;
  /** Id for the ledger entry, if one is produced. */
  entryId: string;
  at: Date;
  /** When true, a still-missing reference is rejected instead of kept pending. */
  referenceWindowExhausted: boolean;
}

export type SettlementOutcome =
  | { status: WagerTransactionStatus.Processed; entry: WalletLedgerEntry | undefined }
  | { status: WagerTransactionStatus.Rejected; failureCode: FailureCode }
  | { status: WagerTransactionStatus.PendingReference; newlyPending: boolean };

type ReferenceCheck =
  | { kind: 'ok'; reference: WagerTransaction | undefined }
  | { kind: 'reject'; failureCode: FailureCode; referenceId?: string }
  | { kind: 'wait' };

/**
 * Applies the wagering rules to a transaction against its wallet. Pure domain logic: the caller
 * provides the wallet (already locked) and the resolved reference, and persists the mutated
 * aggregates afterwards. The same service backs the HTTP and SQS entry points.
 */
export class WagerSettlement {
  static settle(input: SettlementInput): SettlementOutcome {
    const { transaction, wallet, at } = input;
    if (transaction.isTerminal()) {
      throw new InvariantViolationError(`Transaction ${transaction.id} is already settled`);
    }
    if (transaction.walletId !== wallet.id) {
      throw new InvariantViolationError('Transaction must be settled against its own wallet');
    }

    if (transaction.playerId !== wallet.playerId) {
      return WagerSettlement.reject(input, FailureCode.WalletPlayerMismatch);
    }
    if (transaction.money.currency !== wallet.currency) {
      return WagerSettlement.reject(input, FailureCode.CurrencyMismatch);
    }

    const check = WagerSettlement.checkReference(input);
    if (check.kind === 'wait') {
      return WagerSettlement.keepPending(input);
    }
    if (check.kind === 'reject') {
      return WagerSettlement.reject(input, check.failureCode, check.referenceId);
    }

    const reference = check.reference;
    const direction = transaction.ledgerDirectionFor(reference);
    if (direction === undefined) {
      transaction.markProcessed(reference?.id, at, wallet.balance);
      return { status: WagerTransactionStatus.Processed, entry: undefined };
    }

    const movement = { entryId: input.entryId, transactionId: transaction.id, at };
    if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
      const failureCode = transaction.isReversal()
        ? FailureCode.ReversalInsufficientFunds
        : FailureCode.InsufficientFunds;
      return WagerSettlement.reject(input, failureCode, reference?.id);
    }
    const entry =
      direction === LedgerDirection.Debit
        ? wallet.debit(transaction.money, movement)
        : wallet.credit(transaction.money, movement);
    transaction.markProcessed(reference?.id, at, wallet.balance);
    return { status: WagerTransactionStatus.Processed, entry };
  }

  private static checkReference(input: SettlementInput): ReferenceCheck {
    const { transaction, wallet } = input;
    if (!transaction.referenceExternalTransactionId) {
      return { kind: 'ok', reference: undefined };
    }
    const reference = input.reference?.transaction;
    if (!reference) {
      return input.referenceWindowExhausted
        ? { kind: 'reject', failureCode: FailureCode.ReferenceNotFound }
        : { kind: 'wait' };
    }
    const reject = (failureCode: FailureCode): ReferenceCheck => ({
      kind: 'reject',
      failureCode,
      referenceId: reference.id,
    });

    if (reference.providerId !== transaction.providerId) {
      throw new InvariantViolationError('Reference must be resolved within the same provider');
    }
    if (!transaction.canReference(reference.kind)) {
      return reject(FailureCode.ReferenceKindNotAllowed);
    }
    if (reference.playerId !== transaction.playerId) {
      return reject(FailureCode.ReferencePlayerMismatch);
    }
    if (reference.walletId !== wallet.id) {
      return reject(FailureCode.ReferenceWalletMismatch);
    }
    if (reference.money.currency !== transaction.money.currency) {
      return reject(FailureCode.ReferenceCurrencyMismatch);
    }
    if (reference.roundId !== transaction.roundId) {
      return reject(FailureCode.ReferenceRoundMismatch);
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      if (reference.isTerminal()) {
        return reject(FailureCode.ReferenceNotProcessed);
      }
      return input.referenceWindowExhausted
        ? reject(FailureCode.ReferenceNotProcessed)
        : { kind: 'wait' };
    }
    if (transaction.isReversal()) {
      if (!reference.money.equals(transaction.money)) {
        return reject(FailureCode.ReferenceAmountMismatch);
      }
      if (input.reference?.alreadyReversed) {
        return reject(FailureCode.ReferenceAlreadyReversed);
      }
    }
    return { kind: 'ok', reference };
  }

  private static reject(
    input: SettlementInput,
    failureCode: FailureCode,
    referenceId?: string,
  ): SettlementOutcome {
    input.transaction.reject(failureCode, input.at, input.wallet.balance, referenceId);
    return { status: WagerTransactionStatus.Rejected, failureCode };
  }

  private static keepPending(input: SettlementInput): SettlementOutcome {
    const { transaction } = input;
    if (transaction.status === WagerTransactionStatus.Pending) {
      transaction.markPendingReference(input.at, input.wallet.balance);
      return { status: WagerTransactionStatus.PendingReference, newlyPending: true };
    }
    return { status: WagerTransactionStatus.PendingReference, newlyPending: false };
  }
}
