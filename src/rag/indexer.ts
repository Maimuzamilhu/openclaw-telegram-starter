/**
 * Indexer Module (Telegram Version)
 * 
 * This module handles indexing messages into the vector database for RAG.
 * 
 * TELEGRAM INDEXING STRATEGY:
 * ---------------------------
 * Telegram bots cannot fetch past message history.
 * Messages are indexed in REAL-TIME as they arrive.
 * 
 * The telegram.ts channel handler calls indexSingleMessage() whenever
 * a message is received. This function creates an embedding and stores
 * it in ChromaDB for later semantic search.
 * 
 * WHAT GETS INDEXED:
 * ------------------
 * - Regular text messages (not commands)
 * - Messages with meaningful content (> 10 chars)
 * - Both private and group messages
 * 
 * WHAT'S EXCLUDED:
 * ----------------
 * - Bot commands (/help, /reset, etc.)
 * - Empty messages or just emojis
 * - Very short messages (< 10 chars)
 */

import { config } from '../config/index.js';
import { createModuleLogger } from '../utils/logger.js';
import { createEmbedding, preprocessText } from './embeddings.js';
import {
  addDocuments,
  documentExists,
  Document,
  initializeVectorStore,
  getDocumentCount,
} from './vectorstore.js';

const logger = createModuleLogger('indexer');

// ============================================
// Types
// ============================================

interface IncomingMessage {
  ts: string;        // Message ID (Telegram message_id as string)
  text: string;      // Message text content
  user: string;      // Telegram user ID as string
  userName?: string;  // Optional display name
}

// ============================================
// Stats tracking
// ============================================

let totalIndexed = 0;
let totalSkipped = 0;
let totalErrors = 0;

// ============================================
// Core Indexing Functions
// ============================================

/**
 * Index a single incoming message in real-time.
 * Called from telegram.ts whenever a message is received.
 */
export async function indexSingleMessage(
  message: IncomingMessage,
  chatId: string,
  chatName: string
): Promise<boolean> {
  if (!config.rag.enabled) {
    return false;
  }

  try {
    // Skip very short messages
    if (!message.text || message.text.length < 10) {
      totalSkipped++;
      return false;
    }

    // Skip commands
    if (message.text.startsWith('/')) {
      totalSkipped++;
      return false;
    }

    // Create unique document ID
    const docId = `tg-${chatId}-${message.ts}`;

    // Check if already indexed
    const exists = await documentExists(docId);
    if (exists) {
      logger.debug(`Message already indexed: ${docId}`);
      totalSkipped++;
      return false;
    }

    // Preprocess text
    const processedText = preprocessText(message.text);
    if (!processedText || processedText.length < 10) {
      totalSkipped++;
      return false;
    }

    // Create embedding
    const embedding = await createEmbedding(processedText);

    // Prepare document
    const doc: Document = {
      id: docId,
      text: processedText,
      embedding,
      metadata: {
        channelId: chatId,
        channelName: chatName,
        userId: message.user,
        userName: message.userName || message.user,
        timestamp: String(Math.floor(Date.now() / 1000)),
        messageTs: message.ts,
        indexedAt: new Date().toISOString(),
      },
    };

    // Store in vector database
    await addDocuments([doc]);
    totalIndexed++;

    logger.debug(`Indexed message ${docId} from ${chatName}`);
    return true;
  } catch (error: any) {
    totalErrors++;
    logger.error(`Failed to index message: ${error.message}`);
    return false;
  }
}

/**
 * Batch index multiple messages at once.
 * Useful for importing historical data from exported files.
 */
export async function indexBatch(
  messages: IncomingMessage[],
  chatId: string,
  chatName: string
): Promise<{ indexed: number; skipped: number; errors: number }> {
  let indexed = 0;
  let skipped = 0;
  let errors = 0;

  for (const msg of messages) {
    try {
      const result = await indexSingleMessage(msg, chatId, chatName);
      if (result) {
        indexed++;
      } else {
        skipped++;
      }
    } catch {
      errors++;
    }
  }

  return { indexed, skipped, errors };
}

// ============================================
// Lifecycle Functions
// ============================================

/**
 * Initialize the indexer (initialize vector store).
 */
export async function startIndexer(): Promise<void> {
  if (!config.rag.enabled) {
    logger.info('RAG is disabled, skipping indexer initialization');
    return;
  }

  try {
    await initializeVectorStore();
    const count = await getDocumentCount();
    logger.info(`Indexer initialized. ${count} documents in vector store.`);
    logger.info('Real-time indexing active — messages will be indexed as they arrive.');
  } catch (error: any) {
    logger.error(`Failed to initialize indexer: ${error.message}`);
    throw error;
  }
}

/**
 * Stop the indexer (no-op for real-time indexing, kept for API compatibility).
 */
export function stopIndexer(): void {
  logger.info(`Indexer stopped. Stats: ${totalIndexed} indexed, ${totalSkipped} skipped, ${totalErrors} errors`);
}

/**
 * Get indexer statistics.
 */
export function getIndexerStats(): {
  totalIndexed: number;
  totalSkipped: number;
  totalErrors: number;
  isEnabled: boolean;
} {
  return {
    totalIndexed,
    totalSkipped,
    totalErrors,
    isEnabled: config.rag.enabled,
  };
}
