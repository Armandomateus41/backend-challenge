import { TransactionNotFoundError } from '../errors';
import { type UnitOfWork } from '../ports/persistence';
import { toWagerTransactionView, type WagerTransactionView } from '../wager-transaction-result';

export class GetWagerTransaction {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransactionView> {
    const transaction = await this.uow.read((scope) => scope.transactions.findById(transactionId));
    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }
    return toWagerTransactionView(transaction);
  }

  async byExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    const transaction = await this.uow.read((scope) =>
      scope.transactions.findByExternalId(providerId, externalTransactionId),
    );
    if (!transaction) {
      throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    }
    return toWagerTransactionView(transaction);
  }
}
