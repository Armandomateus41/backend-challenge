import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema. Financial invariants are enforced here, not only in application code:
 * uniqueness, non-negative balances, ledger arithmetic, ledger immutability, terminal transaction
 * states, single reversal per reference, and wallet-to-ledger consistency at commit time.
 */
export class Migration20261026000000InitialSchema extends Migration {
  override name = 'Migration20261026000000InitialSchema';

  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid PRIMARY KEY,
        player_id   text NOT NULL CHECK (char_length(player_id) BETWEEN 1 AND 128),
        currency    char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20, 2) NOT NULL CHECK (balance >= 0),
        version     integer NOT NULL CHECK (version >= 1),
        created_at  timestamptz NOT NULL,
        updated_at  timestamptz NOT NULL,
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid PRIMARY KEY,
        provider_id                       text NOT NULL CHECK (char_length(provider_id) BETWEEN 1 AND 128),
        external_transaction_id           text NOT NULL CHECK (char_length(external_transaction_id) BETWEEN 1 AND 256),
        idempotency_key                   text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
        payload_hash                      char(64) NOT NULL,
        wallet_id                         uuid NOT NULL REFERENCES wallets (id),
        player_id                         text NOT NULL,
        round_id                          text NOT NULL,
        game_id                           text NOT NULL,
        kind                              text NOT NULL
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                            numeric(20, 2) NOT NULL CHECK (amount >= 0),
        currency                          char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text NULL,
        reference_transaction_id          uuid NULL REFERENCES wager_transactions (id),
        status                            text NOT NULL
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                      text NULL,
        observed_balance                  numeric(20, 2) NULL CHECK (observed_balance >= 0),
        resolution_attempts               integer NOT NULL DEFAULT 0 CHECK (resolution_attempts >= 0),
        next_attempt_at                   timestamptz NULL,
        correlation_id                    text NULL,
        created_at                        timestamptz NOT NULL,
        updated_at                        timestamptz NOT NULL,
        processed_at                      timestamptz NULL,
        CONSTRAINT uq_wager_transactions_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_wager_transactions_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT ck_wager_transactions_reversal_reference
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT ck_wager_transactions_positive_amount CHECK (kind = 'LOSS' OR amount > 0),
        CONSTRAINT ck_wager_transactions_failure_code
          CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT ck_wager_transactions_processed_at
          CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CONSTRAINT ck_wager_transactions_pending_schedule
          CHECK ((status = 'PENDING_REFERENCE') = (next_attempt_at IS NOT NULL)),
        CONSTRAINT ck_wager_transactions_observed_balance
          CHECK (status IN ('PENDING', 'FAILED') OR observed_balance IS NOT NULL)
      );
    `);

    // A transaction can be reversed (REFUND or ROLLBACK) at most once.
    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_transactions_single_reversal
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED';
    `);
    this.addSql(`
      CREATE INDEX ix_wager_transactions_pending_due
        ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      CREATE INDEX ix_wager_transactions_pending_by_reference
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      CREATE INDEX ix_wager_transactions_wallet ON wager_transactions (wallet_id, created_at);
    `);

    // Terminal states are final and business columns never change after insert.
    this.addSql(`
      CREATE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions rows cannot be deleted'
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'transaction % is in terminal status % and cannot change', OLD.id, OLD.status
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'immutable columns of transaction % cannot change', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_wager_transactions_guard
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard();
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid PRIMARY KEY,
        wallet_id       uuid NOT NULL REFERENCES wallets (id),
        transaction_id  uuid NOT NULL REFERENCES wager_transactions (id),
        direction       text NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount          numeric(20, 2) NOT NULL CHECK (amount > 0),
        currency        char(3) NOT NULL,
        balance_before  numeric(20, 2) NOT NULL CHECK (balance_before >= 0),
        balance_after   numeric(20, 2) NOT NULL CHECK (balance_after >= 0),
        wallet_version  integer NOT NULL CHECK (wallet_version >= 1),
        created_at      timestamptz NOT NULL,
        CONSTRAINT uq_ledger_transaction_per_wallet UNIQUE (wallet_id, transaction_id),
        CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      );
    `);

    // Append-only ledger: entries are never updated nor deleted.
    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% rejected)', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_wallet_ledger_entries_immutable
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_immutable();
    `);

    // Each entry must continue the wallet's chain and belong to a processed, balance-moving transaction.
    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_validate() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        previous  record;
        tx        record;
        wallet_currency char(3);
      BEGIN
        SELECT currency INTO wallet_currency FROM wallets WHERE id = NEW.wallet_id;
        IF wallet_currency IS DISTINCT FROM NEW.currency THEN
          RAISE EXCEPTION 'ledger currency % differs from wallet currency %', NEW.currency, wallet_currency
            USING ERRCODE = 'check_violation';
        END IF;

        SELECT status, kind, wallet_id, amount, currency INTO tx
          FROM wager_transactions WHERE id = NEW.transaction_id;
        IF tx.status IS DISTINCT FROM 'PROCESSED' OR tx.kind = 'LOSS'
           OR tx.wallet_id <> NEW.wallet_id OR tx.amount <> NEW.amount OR tx.currency <> NEW.currency THEN
          RAISE EXCEPTION 'ledger entry does not match a processed balance-moving transaction %', NEW.transaction_id
            USING ERRCODE = 'check_violation';
        END IF;

        SELECT balance_after, wallet_version INTO previous
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id
         ORDER BY wallet_version DESC
         LIMIT 1;
        IF NOT FOUND THEN
          IF NEW.balance_before <> 0 THEN
            RAISE EXCEPTION 'first ledger entry of wallet % must start from zero', NEW.wallet_id
              USING ERRCODE = 'check_violation';
          END IF;
        ELSIF NEW.balance_before <> previous.balance_after OR NEW.wallet_version <= previous.wallet_version THEN
          RAISE EXCEPTION 'ledger entry breaks the chain of wallet %', NEW.wallet_id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_wallet_ledger_entries_validate
        BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_validate();
    `);

    // At commit, the materialized balance and version must match the last ledger entry.
    this.addSql(`
      CREATE FUNCTION wallets_assert_ledger_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        current_wallet record;
        latest record;
      BEGIN
        SELECT balance, version INTO current_wallet FROM wallets WHERE id = NEW.id;
        IF NOT FOUND THEN
          RETURN NULL;
        END IF;
        SELECT balance_after, wallet_version INTO latest
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.id
         ORDER BY wallet_version DESC
         LIMIT 1;
        IF NOT FOUND THEN
          IF current_wallet.balance <> 0 OR current_wallet.version <> 1 THEN
            RAISE EXCEPTION 'wallet % has balance % without ledger entries', NEW.id, current_wallet.balance
              USING ERRCODE = 'check_violation';
          END IF;
        ELSIF current_wallet.balance <> latest.balance_after OR current_wallet.version <> latest.wallet_version THEN
          RAISE EXCEPTION 'wallet % (balance %, version %) diverges from ledger (balance %, version %)',
            NEW.id, current_wallet.balance, current_wallet.version, latest.balance_after, latest.wallet_version
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END;
      $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_wallets_ledger_consistency
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallets_assert_ledger_consistency();
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name   text NOT NULL,
        message_id      text NOT NULL,
        payload_hash    char(64) NOT NULL,
        transaction_id  uuid NULL REFERENCES wager_transactions (id),
        received_at     timestamptz NOT NULL,
        processed_at    timestamptz NULL,
        CONSTRAINT pk_inbox_messages PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid PRIMARY KEY,
        sequence         bigint GENERATED ALWAYS AS IDENTITY,
        aggregate_id     text NOT NULL,
        ordering_key     text NOT NULL,
        event_type       text NOT NULL,
        payload          jsonb NOT NULL,
        occurred_at      timestamptz NOT NULL,
        attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at  timestamptz NULL,
        published_at     timestamptz NULL,
        locked_by        text NULL,
        locked_until     timestamptz NULL,
        last_error       text NULL,
        CONSTRAINT uq_outbox_messages_sequence UNIQUE (sequence),
        CONSTRAINT ck_outbox_messages_published_unlocked CHECK (published_at IS NULL OR locked_by IS NULL)
      );
    `);
    this.addSql(`
      CREATE INDEX ix_outbox_messages_pending
        ON outbox_messages (next_attempt_at, sequence)
        WHERE published_at IS NULL;
    `);

    // Event content is immutable and a published message never returns to pending.
    this.addSql(`
      CREATE FUNCTION outbox_messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.published_at IS NOT NULL THEN
          RAISE EXCEPTION 'outbox message % is already published', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF (NEW.id, NEW.aggregate_id, NEW.ordering_key, NEW.event_type, NEW.payload, NEW.occurred_at)
           IS DISTINCT FROM
           (OLD.id, OLD.aggregate_id, OLD.ordering_key, OLD.event_type, OLD.payload, OLD.occurred_at) THEN
          RAISE EXCEPTION 'outbox message % content is immutable', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_outbox_messages_guard
        BEFORE UPDATE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION outbox_messages_guard();
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP FUNCTION IF EXISTS outbox_messages_guard();');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP FUNCTION IF EXISTS wallet_ledger_entries_validate();');
    this.addSql('DROP FUNCTION IF EXISTS wallet_ledger_entries_immutable();');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP FUNCTION IF EXISTS wager_transactions_guard();');
    this.addSql('DROP TABLE IF EXISTS wallets;');
    this.addSql('DROP FUNCTION IF EXISTS wallets_assert_ledger_consistency();');
  }
}
