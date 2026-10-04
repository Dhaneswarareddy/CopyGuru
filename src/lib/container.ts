import { loadConfig, type AppConfig } from '@/lib/config';
import { createDb, type Db } from '@/lib/database/client';
import { migrate } from '@/lib/database/migrations';
import { activityRepo } from '@/lib/database/repositories/activity';
import { challengesRepo } from '@/lib/database/repositories/challenges';
import { chatRepo } from '@/lib/database/repositories/chat';
import { joinRequestsRepo } from '@/lib/database/repositories/joinRequests';
import { questionsRepo } from '@/lib/database/repositories/questions';
import { sessionsRepo } from '@/lib/database/repositories/sessions';
import { EventBus } from '@/lib/events/bus';
import { registerCoreSubscribers } from '@/lib/events/subscribers';
import { getRealtimeGateway, type RealtimeGateway } from '@/lib/realtime/gateway';
import { DefaultAnswerMatchingService, type AnswerMatchingService } from '@/services/answerMatching';
import { ChallengeService } from '@/services/challenges/challengeService';
import { ChatService } from '@/services/chat/chatService';
import { DemoService } from '@/services/demo/demoService';
import { ImageProcessor } from '@/services/imageProcessing/imageProcessor';
import {
  PgVectorImageSimilarityService,
  createEmbedder,
  type ImageEmbedder,
  type ImageSimilarityService,
} from '@/services/imageSimilarity';
import { NotificationService } from '@/services/notifications/notificationService';
import { QuestionService } from '@/services/questions/questionService';
import { JoinRequestService } from '@/services/sessions/joinRequestService';
import { SessionService } from '@/services/sessions/sessionService';
import { createStorage, type StorageService } from '@/services/storage';
import { SubmissionService } from '@/services/submissions/submissionService';

/**
 * Composition root. Every service receives its dependencies here, so any of
 * them (embedder, storage, answer matcher, realtime gateway…) can be replaced
 * — in production by configuration, in tests by passing overrides.
 */
export interface Container {
  config: AppConfig;
  db: Db;
  bus: EventBus;
  storage: StorageService;
  embedder: ImageEmbedder;
  similarity: ImageSimilarityService;
  matcher: AnswerMatchingService;
  repos: {
    sessions: ReturnType<typeof sessionsRepo>;
    questions: ReturnType<typeof questionsRepo>;
    challenges: ReturnType<typeof challengesRepo>;
    activity: ReturnType<typeof activityRepo>;
    chat: ReturnType<typeof chatRepo>;
    joinRequests: ReturnType<typeof joinRequestsRepo>;
  };
  sessions: SessionService;
  questions: QuestionService;
  submissions: SubmissionService;
  challenges: ChallengeService;
  notifications: NotificationService;
  chat: ChatService;
  joinRequests: JoinRequestService;
  demo: DemoService;
}

export interface ContainerOverrides {
  config?: AppConfig;
  db?: Db;
  embedder?: ImageEmbedder;
  similarity?: ImageSimilarityService;
  storage?: StorageService;
  matcher?: AnswerMatchingService;
  realtime?: RealtimeGateway;
}

export async function createContainer(overrides: ContainerOverrides = {}): Promise<Container> {
  const config = overrides.config ?? loadConfig();
  const db = overrides.db ?? (await createDb(config.database));
  await migrate(db);

  const repos = {
    sessions: sessionsRepo(db),
    questions: questionsRepo(db),
    challenges: challengesRepo(db),
    activity: activityRepo(db),
    chat: chatRepo(db),
    joinRequests: joinRequestsRepo(db),
  };
  const bus = new EventBus();
  const realtime = () => overrides.realtime ?? getRealtimeGateway();
  const storage = overrides.storage ?? createStorage(config.storage, db);
  const matcher = overrides.matcher ?? new DefaultAnswerMatchingService();
  const embedder = overrides.embedder ?? createEmbedder(config.similarity);
  const similarity =
    overrides.similarity ?? new PgVectorImageSimilarityService(embedder, repos.questions, config.similarity.topK);

  const common = { config, db, bus, sessions: repos.sessions, questions: repos.questions, matcher };
  const questions = new QuestionService({ ...common, challenges: repos.challenges, activity: repos.activity });
  const challenges = new ChallengeService({ ...common, challenges: repos.challenges, questionService: questions });
  const submissions = new SubmissionService({
    ...common,
    similarity,
    images: new ImageProcessor(config.images),
    storage,
    questionService: questions,
    challengeService: challenges,
  });
  const sessions = new SessionService({
    config,
    db,
    bus,
    sessions: repos.sessions,
    activity: repos.activity,
    realtime,
    questionService: questions,
    submissionService: () => submissions,
  });
  const notifications = new NotificationService({
    config,
    sessions: repos.sessions,
    questions: repos.questions,
    activity: repos.activity,
    realtime,
  });
  const chat = new ChatService({ sessions: repos.sessions, chat: repos.chat, realtime });
  const joinRequests = new JoinRequestService({
    config,
    db,
    bus,
    sessions: repos.sessions,
    joinRequests: repos.joinRequests,
    realtime,
    sessionService: sessions,
  });
  const demo = new DemoService({ config, sessionService: sessions, submissionService: submissions });

  registerCoreSubscribers(bus, { activity: repos.activity, realtime, notify: notifications.handle });

  return {
    config, db, bus, storage, embedder, similarity, matcher, repos,
    sessions, questions, submissions, challenges, notifications, chat, joinRequests, demo,
  };
}

// One container per process. Stored on globalThis because the custom server
// (server.ts) and Next.js route handlers are loaded as separate module graphs.
const g = globalThis as unknown as { __vqaContainer?: Promise<Container> };

export function getContainer(): Promise<Container> {
  if (!g.__vqaContainer) {
    g.__vqaContainer = createContainer().catch((err) => {
      g.__vqaContainer = undefined;
      throw err;
    });
  }
  return g.__vqaContainer;
}
