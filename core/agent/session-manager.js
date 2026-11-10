export class SessionManager {
  #sessions = new Map();

  getOrCreate(clientId, sessionId) {
    const key = sessionKey(clientId, sessionId);
    let session = this.#sessions.get(key);
    if (!session) {
      session = {
        clientId,
        sessionId,
        activeSkillIds: new Set(),
      };
      this.#sessions.set(key, session);
    }
    return session;
  }

  get(clientId, sessionId) {
    return this.#sessions.get(sessionKey(clientId, sessionId));
  }

  close(clientId, sessionId) {
    return this.#sessions.delete(sessionKey(clientId, sessionId));
  }
}

function sessionKey(clientId, sessionId) {
  return JSON.stringify([clientId, sessionId]);
}
