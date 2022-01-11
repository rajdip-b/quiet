export enum EventTypesServer {
  CLOSE = 'close',
  CONNECTION = 'connection',
  DISCONNECTED = 'disconnect',
  MESSAGE = 'message',
  ERROR = 'error',
  SEND_MESSAGE = 'sendMessage',
  FETCH_ALL_MESSAGES = 'fetchAllMessages',
  SUBSCRIBE_FOR_TOPIC = 'subscribeForTopic',
  ADD_TOR_SERVICE = 'addTorService',
  REMOVE_TOR_SERVICE = 'removeTorService',
  GET_PUBLIC_CHANNELS = 'getPublicChannels',
  INITIALIZE_CONVERSATION = 'initializeConversation',
  GET_AVAILABLE_USERS = 'getAvailableUsers',
  GET_PRIVATE_CONVERSATIONS = 'getPrivateConversations',
  SEND_PRIVATE_MESSAGE = 'sendPrivateMessage',
  ADD_USER = 'addUser',
  SEND_DIRECT_MESSAGE = 'sendDirectMessage',
  FETCH_ALL_DIRECT_MESSAGES = 'fetchAllDirectMessages',
  SUBSCRIBE_FOR_DIRECT_MESSAGE_THREAD = 'subscribeForDirectMessageThread',
  DIRECT_MESSAGE = 'directMessage',
  SUBSCRIBE_FOR_ALL_CONVERSATIONS = 'subscribeForAllConversations',
  REQUEST_PEER_ID = 'requestPeerId',
  ASK_FOR_MESSAGES = 'askForMessages',
  REGISTER_USER_CERTIFICATE = 'registerUserCertificate',
  REGISTER_OWNER_CERTIFICATE = 'registerOwnerCertificate',
  SAVE_CERTIFICATE = 'saveCertificate',
  CREATE_COMMUNITY = 'createCommunity',
  CREATE_NETWORK = 'createNetwork',
  LAUNCH_COMMUNITY = 'launchCommunity',
  LAUNCH_REGISTRAR = 'launchRegistrar',
  SAVE_OWNER_CERTIFICATE = 'saveOwnerCertificate',
  PEER_CONNECT = 'peer:connect',
  PEER_DISCONNECT = 'peer:disconnect'
}
