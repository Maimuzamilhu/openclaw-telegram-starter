/**
 * Telegram AI Assistant - Main Entry Point
 * 
 * This is the entry point for the AI Assistant with:
 * - RAG (Retrieval Augmented Generation) for semantic search
 * - mem0 Long-Term Memory for personalization
 * - MCP (Model Context Protocol) for GitHub, Notion integration
 * - Real-time message indexing
 * - Tool-using AI agent
 * 
 * STARTUP SEQUENCE:
 * -----------------
 * 1. Load configuration from environment
 * 2. Initialize database (SQLite for sessions)
 * 3. Initialize vector store (ChromaDB for RAG)
 * 4. Initialize memory system (mem0)
 * 5. Initialize MCP servers (GitHub, Notion)
 * 6. Start Telegram bot
 * 7. Handle graceful shutdown
 */

import { config } from './config/index.js';
import { createModuleLogger } from './utils/logger.js';
import { initializeDatabase, closeDatabase } from './memory/database.js';
import { startTelegramBot, stopTelegramBot } from './channels/telegram.js';
import { taskScheduler } from './tools/scheduler.js';

// RAG imports
import { initializeVectorStore, getDocumentCount } from './rag/index.js';
import { startIndexer, stopIndexer } from './rag/indexer.js';

// Memory imports (mem0)
import { initializeMemory, isMemoryEnabled } from './memory-ai/index.js';

// MCP imports
import { initializeMCP, shutdownMCP, isMCPEnabled, getConnectedServers } from './mcp/index.js';

const logger = createModuleLogger('main');

/**
 * Initialize all services and start the application.
 */
async function main(): Promise<void> {
  logger.info('='.repeat(50));
  logger.info('Starting Telegram AI Assistant');
  logger.info('='.repeat(50));

  try {
    // 1. Initialize SQLite database for sessions/messages
    logger.info('Initializing database...');
    initializeDatabase();
    logger.info('✅ Database initialized');

    // 2. Initialize RAG system if enabled
    if (config.rag.enabled) {
      logger.info('Initializing RAG system...');

      // Initialize vector store
      await initializeVectorStore();
      const docCount = await getDocumentCount();
      logger.info(`✅ Vector store initialized (${docCount} documents)`);

      // Start indexer (initializes vector store for real-time indexing)
      await startIndexer();
      logger.info('✅ Real-time indexer ready');
    } else {
      logger.info('⏭️  RAG system disabled');
    }

    // 3. Initialize memory system (mem0)
    if (config.memory.enabled) {
      logger.info('Initializing memory system (mem0)...');
      await initializeMemory();
      if (isMemoryEnabled()) {
        logger.info('✅ Memory system initialized');
      } else {
        logger.warn('⚠️  Memory system failed to initialize (will continue without memory)');
      }
    } else {
      logger.info('⏭️  Memory system disabled');
    }

    // 4. Initialize MCP servers (GitHub, Notion)
    logger.info('Initializing MCP servers...');
    await initializeMCP();
    if (isMCPEnabled()) {
      const servers = getConnectedServers();
      logger.info(`✅ MCP initialized: ${servers.join(', ')}`);
    } else {
      logger.info('⏭️  No MCP servers connected (set GITHUB_PERSONAL_ACCESS_TOKEN or NOTION_API_TOKEN)');
    }

    // 5. Start Telegram bot (includes task scheduler)
    logger.info('Starting Telegram bot...');
    await startTelegramBot();
    logger.info('✅ Telegram bot started');

    // Ready!
    logger.info('='.repeat(50));
    logger.info('🚀 Telegram AI Assistant is running!');
    logger.info('='.repeat(50));
    logger.info('Features enabled:');
    logger.info(`  • RAG (Semantic Search): ${config.rag.enabled ? '✅' : '❌'}`);
    logger.info(`  • Long-Term Memory: ${config.memory.enabled && isMemoryEnabled() ? '✅' : '❌'}`);
    logger.info(`  • MCP (GitHub/Notion): ${isMCPEnabled() ? '✅ ' + getConnectedServers().join(', ') : '❌'}`);
    logger.info(`  • Task Scheduler: ✅`);
    logger.info(`  • AI Model: ${config.ai.defaultModel}`);
    logger.info('='.repeat(50));
    logger.info('Press Ctrl+C to stop');

  } catch (error: any) {
    logger.error('Failed to start application', { error: error.message });
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler.
 * Ensures all services are properly stopped.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info(`\n${signal} received, shutting down gracefully...`);

  try {
    // Stop Telegram bot
    logger.info('Stopping Telegram bot...');
    await stopTelegramBot();

    // Stop MCP servers
    logger.info('Stopping MCP servers...');
    await shutdownMCP();

    // Stop indexer
    if (config.rag.enabled) {
      logger.info('Stopping indexer...');
      stopIndexer();
    }

    // Stop scheduler
    logger.info('Stopping scheduler...');
    taskScheduler.stop();

    // Close database
    logger.info('Closing database...');
    closeDatabase();

    logger.info('✅ Shutdown complete');
    process.exit(0);
  } catch (error: any) {
    logger.error('Error during shutdown', { error: error.message });
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason, promise });
});

// Start the application
main();
