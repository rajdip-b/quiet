import { Inject, Injectable, OnModuleInit } from '@nestjs/common'
import { Crypto } from '@peculiar/webcrypto'
import { Agent } from 'https'
import fs from 'fs'
import path from 'path'
import { peerIdFromKeys } from '@libp2p/peer-id'
import { setEngine, CryptoEngine } from 'pkijs'
import { EventEmitter } from 'events'
import getPort from 'get-port'
import PeerId from 'peer-id'
import { getLibp2pAddressesFromCsrs, removeFilesFromDir } from '../common/utils'

import {
  AskForMessagesPayload,
  ChannelMessagesIdsResponse,
  ChannelsReplicatedPayload,
  Community,
  CommunityId,
  ConnectionProcessInfo,
  CreateChannelPayload,
  CreatedChannelResponse,
  DeleteFilesFromChannelSocketPayload,
  DownloadStatus,
  ErrorMessages,
  FileMetadata,
  IncomingMessages,
  InitCommunityPayload,
  NetworkData,
  NetworkDataPayload,
  NetworkStats,
  PushNotificationPayload,
  RegisterOwnerCertificatePayload,
  RemoveDownloadStatus,
  ResponseCreateNetworkPayload,
  SendCertificatesResponse,
  SendMessagePayload,
  SetChannelSubscribedPayload,
  SocketActionTypes,
  StorePeerListPayload,
  UploadFilePayload,
  PeerId as PeerIdType,
  SaveCSRPayload,
  CommunityMetadata,
  PermsData,
} from '@quiet/types'
import { CONFIG_OPTIONS, QUIET_DIR, SERVER_IO_PROVIDER, SOCKS_PROXY_AGENT } from '../const'
import { ConfigOptions, GetPorts, ServerIoProviderTypes } from '../types'
import { SocketService } from '../socket/socket.service'
import { RegistrationService } from '../registration/registration.service'
import { LocalDbService } from '../local-db/local-db.service'
import { StorageService } from '../storage/storage.service'
import { ServiceState, TorInitState } from './connections-manager.types'
import { Libp2pService } from '../libp2p/libp2p.service'
import { Tor } from '../tor/tor.service'
import { LocalDBKeys } from '../local-db/local-db.types'
import { Libp2pEvents, Libp2pNodeParams } from '../libp2p/libp2p.types'
import { RegistrationEvents } from '../registration/registration.types'
import { StorageEvents } from '../storage/storage.types'
import { LazyModuleLoader } from '@nestjs/core'
import Logger from '../common/logger'
import { emitError } from '../socket/socket.errors'
import { isPSKcodeValid } from '@quiet/common'

@Injectable()
export class ConnectionsManagerService extends EventEmitter implements OnModuleInit {
  public communityId: string
  public communityState: ServiceState
  public libp2pService: Libp2pService
  private ports: GetPorts
  isTorInit: TorInitState = TorInitState.NOT_STARTED

  private readonly logger = Logger(ConnectionsManagerService.name)
  constructor(
    @Inject(SERVER_IO_PROVIDER) public readonly serverIoProvider: ServerIoProviderTypes,
    @Inject(CONFIG_OPTIONS) public configOptions: ConfigOptions,
    @Inject(QUIET_DIR) public readonly quietDir: string,
    @Inject(SOCKS_PROXY_AGENT) public readonly socksProxyAgent: Agent,
    private readonly socketService: SocketService,
    private readonly registrationService: RegistrationService,
    private readonly localDbService: LocalDbService,
    private readonly storageService: StorageService,
    private readonly tor: Tor,
    private readonly lazyModuleLoader: LazyModuleLoader
  ) {
    super()
  }

  async onModuleInit() {
    process.on('unhandledRejection', error => {
      console.error(error)
      throw new Error()
    })
    // process.on('SIGINT', function () {
    //   // This is not graceful even in a single percent. we must close services first, not just kill process %
    //   // this.logger('\nGracefully shutting down from SIGINT (Ctrl-C)')
    //   process.exit(0)
    // })
    const webcrypto = new Crypto()
    // @ts-ignore
    global.crypto = webcrypto

    setEngine(
      'newEngine',
      new CryptoEngine({
        name: 'newEngine',
        // @ts-ignore
        crypto: webcrypto,
      })
    )

    await this.init()
  }

  private async generatePorts() {
    const controlPort = await getPort()
    const socksPort = await getPort()
    const libp2pHiddenService = await getPort()
    const dataServer = await getPort()
    const httpTunnelPort = await getPort()

    this.ports = {
      socksPort,
      libp2pHiddenService,
      controlPort,
      dataServer,
      httpTunnelPort,
    }
  }

  public async init() {
    console.log('init')
    this.communityState = ServiceState.DEFAULT
    await this.generatePorts()
    if (!this.configOptions.httpTunnelPort) {
      this.configOptions.httpTunnelPort = await getPort()
    }

    this.attachSocketServiceListeners()
    this.attachRegistrationListeners()
    this.attachTorEventsListeners()
    this.attachStorageListeners()

    if (this.localDbService.getStatus() === 'closed') {
      await this.localDbService.open()
    }

    if (this.configOptions.torControlPort) {
      console.log('launch 1')
      await this.launchCommunityFromStorage()
    }
  }

  public async launchCommunityFromStorage() {
    this.logger('launchCommunityFromStorage')

    const community: InitCommunityPayload = await this.localDbService.get(LocalDBKeys.COMMUNITY)
    this.logger('launchCommunityFromStorage - community peers', community?.peers)
    if (community) {
      const sortedPeers = await this.localDbService.getSortedPeers(community.peers)
      this.logger('launchCommunityFromStorage - sorted peers', sortedPeers)
      if (sortedPeers.length > 0) {
        community.peers = sortedPeers
      }
      await this.localDbService.put(LocalDBKeys.COMMUNITY, community)
      if ([ServiceState.LAUNCHING, ServiceState.LAUNCHED].includes(this.communityState)) return
      this.communityState = ServiceState.LAUNCHING
      await this.launchCommunity(community)
    }
  }

  public async closeAllServices(options: { saveTor: boolean } = { saveTor: false }) {
    if (this.tor && !options.saveTor) {
      await this.tor.kill()
    }
    if (this.storageService) {
      this.logger('Stopping orbitdb')
      await this.storageService?.stopOrbitDb()
      this.logger('reset CsrReplicated map and id and certificate store values')
      this.storageService.resetCsrAndCertsValues()
    }
    if (this.serverIoProvider?.io) {
      this.logger('Closing socket server')
      this.serverIoProvider.io.close()
    }
    if (this.localDbService) {
      this.logger('Closing local storage')
      await this.localDbService.close()
    }
    if (this.libp2pService) {
      this.logger('Stopping libp2p')
      await this.libp2pService.close()
    }
  }

  public closeSocket() {
    this.serverIoProvider.io.close()
  }

  // This method is only used on iOS through rn-bridge for reacting on lifecycle changes
  public async openSocket() {
    await this.socketService.init()
  }

  public async leaveCommunity() {
    this.tor.resetHiddenServices()
    this.closeSocket()
    await this.localDbService.purge()
    await this.closeAllServices({ saveTor: true })
    await this.purgeData()
    await this.resetState()
    await this.localDbService.open()
    await this.socketService.init()
  }

  async resetState() {
    this.communityId = ''
    this.ports = { ...this.ports, libp2pHiddenService: await getPort() }
    this.communityState = ServiceState.DEFAULT
  }

  public async purgeData() {
    this.logger('Purging community data')
    const dirsToRemove = fs
      .readdirSync(this.quietDir)
      .filter(
        i =>
          i.startsWith('Ipfs') || i.startsWith('OrbitDB') || i.startsWith('backendDB') || i.startsWith('Local Storage')
      )
    for (const dir of dirsToRemove) {
      removeFilesFromDir(path.join(this.quietDir, dir))
    }
  }

  public async getNetwork() {
    const hiddenService = await this.tor.createNewHiddenService({ targetPort: this.ports.libp2pHiddenService })

    await this.tor.destroyHiddenService(hiddenService.onionAddress.split('.')[0])
    const peerId: PeerId = await PeerId.create()
    const peerIdJson = peerId.toJSON()
    this.logger(`Created network for peer ${peerId.toString()}. Address: ${hiddenService.onionAddress}`)

    return {
      hiddenService,
      peerId: peerIdJson,
    }
  }

  public async createNetwork(community: Community) {
    let network: NetworkData
    // For registrar service purposes, if community owner
    // FIXME: Remove if obselete
    let network2: NetworkData
    try {
      network = await this.getNetwork()
      network2 = await this.getNetwork()
    } catch (e) {
      this.logger.error(`Creating network for community ${community.id} failed`, e)
      emitError(this.serverIoProvider.io, {
        type: SocketActionTypes.NETWORK,
        message: ErrorMessages.NETWORK_SETUP_FAILED,
        community: community.id,
      })
      return
    }

    this.logger(`Sending network data for ${community.id}`)

    // It might be nice to save the entire Community in LevelDB rather
    // than specific pieces of information.

    const psk = community.psk
    if (psk) {
      this.logger('Creating network: received Libp2p PSK')
      if (!isPSKcodeValid(psk)) {
        this.logger.error('Creating network: received Libp2p PSK is not valid')
        emitError(this.serverIoProvider.io, {
          type: SocketActionTypes.NETWORK,
          message: ErrorMessages.NETWORK_SETUP_FAILED,
          community: community.id,
        })
        return
      }
      await this.localDbService.put(LocalDBKeys.PSK, psk)
    }

    const ownerOrbitDbIdentity = community.ownerOrbitDbIdentity
    if (ownerOrbitDbIdentity) {
      this.logger("Creating network: received owner's OrbitDB identity")
      await this.localDbService.putOwnerOrbitDbIdentity(ownerOrbitDbIdentity)
    }

    const payload: ResponseCreateNetworkPayload = {
      community: {
        ...community,
        privateKey: network2.hiddenService.privateKey,
      },
      network,
    }

    this.serverIoProvider.io.emit(SocketActionTypes.NETWORK, payload)
  }

  private async generatePSK() {
    const pskBase64 = Libp2pService.generateLibp2pPSK().psk
    await this.localDbService.put(LocalDBKeys.PSK, pskBase64)
    this.logger('Generated Libp2p PSK')
    this.serverIoProvider.io.emit(SocketActionTypes.LIBP2P_PSK_SAVED, { psk: pskBase64 })
  }

  public async createCommunity(payload: InitCommunityPayload) {
    this.logger('Creating community: peers:', payload.peers)

    await this.generatePSK()

    await this.launchCommunity(payload)
    this.logger(`Created and launched community ${payload.id}`)
    this.serverIoProvider.io.emit(SocketActionTypes.NEW_COMMUNITY, { id: payload.id })
  }

  public async launchCommunity(payload: InitCommunityPayload) {
    this.logger('Launching community: peers:', payload.peers)
    this.communityState = ServiceState.LAUNCHING
    // Perhaps we should call this data something else, since we already have a Community type.
    // It seems like InitCommunityPayload is a mix of various connection metadata.
    const communityData: InitCommunityPayload = await this.localDbService.get(LocalDBKeys.COMMUNITY)
    if (!communityData) {
      await this.localDbService.put(LocalDBKeys.COMMUNITY, payload)
    }

    try {
      await this.launch(payload)
    } catch (e) {
      this.logger(`Couldn't launch community for peer ${payload.peerId.id}.`, e)
      emitError(this.serverIoProvider.io, {
        type: SocketActionTypes.COMMUNITY,
        message: ErrorMessages.COMMUNITY_LAUNCH_FAILED,
        community: payload.id,
        trace: e.stack,
      })
      return
    }

    this.logger(`Launched community ${payload.id}`)

    this.serverIoProvider.io.emit(SocketActionTypes.CONNECTION_PROCESS_INFO, ConnectionProcessInfo.LAUNCHED_COMMUNITY)

    this.communityId = payload.id
    this.communityState = ServiceState.LAUNCHED

    console.log('Hunting for heisenbug: Backend initialized community and sent event to state manager')

    // Unblock websocket endpoints
    this.socketService.resolveReadyness()

    this.serverIoProvider.io.emit(SocketActionTypes.COMMUNITY, { id: payload.id })
  }

  public async launch(payload: InitCommunityPayload) {
    // Start existing community (community that user is already a part of)
    this.logger(`Spawning hidden service for community ${payload.id}, peer: ${payload.peerId.id}`)
    this.serverIoProvider.io.emit(
      SocketActionTypes.CONNECTION_PROCESS_INFO,
      ConnectionProcessInfo.SPAWNING_HIDDEN_SERVICE
    )
    const onionAddress: string = await this.tor.spawnHiddenService({
      targetPort: this.ports.libp2pHiddenService,
      privKey: payload.hiddenService.privateKey,
    })
    this.logger(`Launching community ${payload.id}: peer: ${payload.peerId.id}`)

    const { Libp2pModule } = await import('../libp2p/libp2p.module')
    const moduleRef = await this.lazyModuleLoader.load(() => Libp2pModule)
    const { Libp2pService } = await import('../libp2p/libp2p.service')
    const lazyService = moduleRef.get(Libp2pService)
    this.libp2pService = lazyService

    const restoredRsa = await PeerId.createFromJSON(payload.peerId)
    const _peerId = await peerIdFromKeys(restoredRsa.marshalPubKey(), restoredRsa.marshalPrivKey())

    let peers = payload.peers
    this.logger(`Launching community ${payload.id}: payload peers: ${peers}`)
    if (!peers || peers.length === 0) {
      peers = [this.libp2pService.createLibp2pAddress(onionAddress, _peerId.toString())]
    }
    const pskValue: string = await this.localDbService.get(LocalDBKeys.PSK)
    if (!pskValue) {
      throw new Error('No psk in local db')
    }
    this.logger(`Launching community ${payload.id}: retrieved Libp2p PSK`)

    const libp2pPSK = Libp2pService.generateLibp2pPSK(pskValue).fullKey
    const params: Libp2pNodeParams = {
      peerId: _peerId,
      listenAddresses: [this.libp2pService.createLibp2pListenAddress(onionAddress)],
      agent: this.socksProxyAgent,
      localAddress: this.libp2pService.createLibp2pAddress(onionAddress, _peerId.toString()),
      targetPort: this.ports.libp2pHiddenService,
      peers,
      psk: libp2pPSK,
    }

    await this.libp2pService.createInstance(params)
    // Libp2p event listeners
    this.libp2pService.on(Libp2pEvents.PEER_CONNECTED, (payload: { peers: string[] }) => {
      this.serverIoProvider.io.emit(SocketActionTypes.PEER_CONNECTED, payload)
    })
    this.libp2pService.on(Libp2pEvents.PEER_DISCONNECTED, async (payload: NetworkDataPayload) => {
      const peerPrevStats = await this.localDbService.find(LocalDBKeys.PEERS, payload.peer)
      const prev = peerPrevStats?.connectionTime || 0

      const peerStats: NetworkStats = {
        peerId: payload.peer,
        connectionTime: prev + payload.connectionDuration,
        lastSeen: payload.lastSeen,
      }

      await this.localDbService.update(LocalDBKeys.PEERS, {
        [payload.peer]: peerStats,
      })
      // BARTEK: Potentially obsolete to send this to state-manager
      this.serverIoProvider.io.emit(SocketActionTypes.PEER_DISCONNECTED, payload)
    })
    await this.storageService.init(_peerId)
    this.logger('storage initialized')

    this.serverIoProvider.io.emit(
      SocketActionTypes.CONNECTION_PROCESS_INFO,
      ConnectionProcessInfo.CONNECTING_TO_COMMUNITY
    )
  }

  private attachTorEventsListeners() {
    this.logger('attachTorEventsListeners')

    this.tor.on(SocketActionTypes.CONNECTION_PROCESS_INFO, data => {
      this.serverIoProvider.io.emit(SocketActionTypes.CONNECTION_PROCESS_INFO, data)
    })
    this.socketService.on(SocketActionTypes.CONNECTION_PROCESS_INFO, data => {
      this.serverIoProvider.io.emit(SocketActionTypes.CONNECTION_PROCESS_INFO, data)
    })
  }
  private attachRegistrationListeners() {
    this.registrationService.on(SocketActionTypes.SAVED_OWNER_CERTIFICATE, payload => {
      this.serverIoProvider.io.emit(SocketActionTypes.SAVED_OWNER_CERTIFICATE, payload)
    })
    this.registrationService.on(RegistrationEvents.ERROR, payload => {
      emitError(this.serverIoProvider.io, payload)
    })
    this.registrationService.on(RegistrationEvents.NEW_USER, async payload => {
      await this.storageService?.saveCertificate(payload)
    })

    this.registrationService.on(RegistrationEvents.FINISHED_ISSUING_CERTIFICATES_FOR_ID, payload => {
      if (payload.id) {
        this.storageService.resolveCsrReplicatedPromise(payload.id)
      }
    })
  }
  private attachSocketServiceListeners() {
    // Community
    this.socketService.on(SocketActionTypes.CONNECTION, async () => {
      // Update Frontend with Initialized Communities
      if (this.communityId) {
        console.log('Hunting for heisenbug: Backend initialized community and sent event to state manager')
        this.serverIoProvider.io.emit(SocketActionTypes.COMMUNITY, { id: this.communityId })
        console.log('this.libp2pService.connectedPeers', this.libp2pService.connectedPeers)
        console.log('this.libp2pservice', this.libp2pService)
        this.serverIoProvider.io.emit(
          SocketActionTypes.CONNECTED_PEERS,
          Array.from(this.libp2pService.connectedPeers.keys())
        )
        await this.storageService?.loadAllCertificates()
        await this.storageService?.loadAllChannels()
      }
    })
    this.socketService.on(SocketActionTypes.CREATE_NETWORK, async (args: Community) => {
      this.logger(`socketService - ${SocketActionTypes.CREATE_NETWORK}`)
      await this.createNetwork(args)
    })
    this.socketService.on(SocketActionTypes.CREATE_COMMUNITY, async (args: InitCommunityPayload) => {
      await this.createCommunity(args)
    })
    this.socketService.on(SocketActionTypes.LAUNCH_COMMUNITY, async (args: InitCommunityPayload) => {
      this.logger(`socketService - ${SocketActionTypes.LAUNCH_COMMUNITY}`)
      if ([ServiceState.LAUNCHING, ServiceState.LAUNCHED].includes(this.communityState)) return
      this.communityState = ServiceState.LAUNCHING
      await this.launchCommunity(args)
    })
    this.socketService.on(SocketActionTypes.LEAVE_COMMUNITY, async () => {
      await this.leaveCommunity()
    })

    // Username registration
    this.socketService.on(SocketActionTypes.SAVE_USER_CSR, async (payload: SaveCSRPayload) => {
      this.logger(`socketService - ${SocketActionTypes.SAVE_USER_CSR}`)
      await this.storageService?.saveCSR(payload)
      this.serverIoProvider.io.emit(SocketActionTypes.SAVED_USER_CSR, payload)
    })
    this.socketService.on(
      SocketActionTypes.REGISTER_OWNER_CERTIFICATE,
      async (args: RegisterOwnerCertificatePayload) => {
        await this.registrationService.registerOwnerCertificate(args)
      }
    )
    // TODO: Save community CA data in LevelDB. Perhaps save the
    // entire Community type in LevelDB. We can probably do this once
    // when creating the community.
    this.socketService.on(SocketActionTypes.SEND_COMMUNITY_CA_DATA, async (payload: PermsData) => {
      this.logger(`socketService - ${SocketActionTypes.SEND_COMMUNITY_CA_DATA}`)
      this.registrationService.permsData = payload
    })

    // Public Channels
    this.socketService.on(SocketActionTypes.CREATE_CHANNEL, async (args: CreateChannelPayload) => {
      await this.storageService?.subscribeToChannel(args.channel)
    })
    this.socketService.on(
      SocketActionTypes.DELETE_CHANNEL,
      async (payload: { channelId: string; ownerPeerId: string }) => {
        await this.storageService?.deleteChannel(payload)
      }
    )
    this.socketService.on(
      SocketActionTypes.DELETE_FILES_FROM_CHANNEL,
      async (payload: DeleteFilesFromChannelSocketPayload) => {
        this.logger(`socketService - ${SocketActionTypes.DELETE_FILES_FROM_CHANNEL}`, payload)
        await this.storageService?.deleteFilesFromChannel(payload)
        // await this.deleteFilesFromTemporaryDir() //crashes on mobile, will be fixes in next versions
      }
    )
    this.socketService.on(SocketActionTypes.SEND_MESSAGE, async (args: SendMessagePayload) => {
      await this.storageService?.sendMessage(args.message)
    })
    this.socketService.on(SocketActionTypes.ASK_FOR_MESSAGES, async (args: AskForMessagesPayload) => {
      await this.storageService?.askForMessages(args.channelId, args.ids)
    })

    // Files
    this.socketService.on(SocketActionTypes.DOWNLOAD_FILE, async (metadata: FileMetadata) => {
      await this.storageService?.downloadFile(metadata)
    })
    this.socketService.on(SocketActionTypes.UPLOAD_FILE, async (metadata: FileMetadata) => {
      await this.storageService?.uploadFile(metadata)
    })
    this.socketService.on(SocketActionTypes.UPLOADED_FILE, async (args: FileMetadata) => {
      await this.storageService?.uploadFile(args)
    })
    this.socketService.on(SocketActionTypes.CANCEL_DOWNLOAD, mid => {
      this.storageService?.cancelDownload(mid)
    })

    // System
    this.socketService.on(SocketActionTypes.CLOSE, async () => {
      await this.closeAllServices()
    })
  }
  private attachStorageListeners() {
    if (!this.storageService) return
    this.storageService.on(SocketActionTypes.CONNECTION_PROCESS_INFO, data => {
      this.serverIoProvider.io.emit(SocketActionTypes.CONNECTION_PROCESS_INFO, data)
    })
    this.storageService.on(StorageEvents.REPLICATED_CERTIFICATES, (payload: SendCertificatesResponse) => {
      this.logger(`Storage - ${StorageEvents.REPLICATED_CERTIFICATES}`)
      this.serverIoProvider.io.emit(SocketActionTypes.RESPONSE_GET_CERTIFICATES, payload)
    })
    this.storageService.on(StorageEvents.LOAD_PUBLIC_CHANNELS, (payload: ChannelsReplicatedPayload) => {
      this.serverIoProvider.io.emit(SocketActionTypes.CHANNELS_REPLICATED, payload)
    })
    this.storageService.on(StorageEvents.LOAD_ALL_PRIVATE_CONVERSATIONS, payload => {
      this.serverIoProvider.io.emit(SocketActionTypes.RESPONSE_GET_PRIVATE_CONVERSATIONS, payload)
    })
    this.storageService.on(StorageEvents.LOAD_MESSAGES, (payload: IncomingMessages) => {
      this.serverIoProvider.io.emit(SocketActionTypes.INCOMING_MESSAGES, payload)
    })
    this.storageService.on(StorageEvents.SEND_MESSAGES_IDS, (payload: ChannelMessagesIdsResponse) => {
      if (payload.ids.length === 0) {
        return
      }
      this.serverIoProvider.io.emit(SocketActionTypes.SEND_MESSAGES_IDS, payload)
    })
    this.storageService.on(StorageEvents.SET_CHANNEL_SUBSCRIBED, (payload: SetChannelSubscribedPayload) => {
      this.serverIoProvider.io.emit(SocketActionTypes.CHANNEL_SUBSCRIBED, payload)
    })
    this.storageService.on(StorageEvents.CREATED_CHANNEL, (payload: CreatedChannelResponse) => {
      this.logger(`Storage - ${StorageEvents.CREATED_CHANNEL}: ${payload.channel.name}`)
      this.serverIoProvider.io.emit(SocketActionTypes.CREATED_CHANNEL, payload)
    })
    this.storageService.on(StorageEvents.REMOVE_DOWNLOAD_STATUS, (payload: RemoveDownloadStatus) => {
      this.serverIoProvider.io.emit(SocketActionTypes.REMOVE_DOWNLOAD_STATUS, payload)
    })
    this.storageService.on(StorageEvents.UPLOADED_FILE, (payload: UploadFilePayload) => {
      this.serverIoProvider.io.emit(SocketActionTypes.UPLOADED_FILE, payload)
    })
    this.storageService.on(StorageEvents.UPDATE_DOWNLOAD_PROGRESS, (payload: DownloadStatus) => {
      this.serverIoProvider.io.emit(SocketActionTypes.DOWNLOAD_PROGRESS, payload)
    })
    this.storageService.on(StorageEvents.UPDATE_MESSAGE_MEDIA, (payload: FileMetadata) => {
      this.serverIoProvider.io.emit(SocketActionTypes.UPDATE_MESSAGE_MEDIA, payload)
    })
    this.storageService.on(StorageEvents.LOAD_ALL_DIRECT_MESSAGES, payload => {
      if (payload.messages.length === 0) {
        return
      }
      this.serverIoProvider.io.emit(SocketActionTypes.RESPONSE_FETCH_ALL_DIRECT_MESSAGES, payload)
    })
    this.storageService.on(StorageEvents.UPDATE_PEERS_LIST, (payload: StorePeerListPayload) => {
      this.serverIoProvider.io.emit(SocketActionTypes.PEER_LIST, payload)
    })
    this.storageService.on(StorageEvents.SEND_PUSH_NOTIFICATION, (payload: PushNotificationPayload) => {
      this.serverIoProvider.io.emit(SocketActionTypes.PUSH_NOTIFICATION, payload)
    })
    this.storageService.on(StorageEvents.CHECK_FOR_MISSING_FILES, (payload: CommunityId) => {
      this.serverIoProvider.io.emit(SocketActionTypes.CHECK_FOR_MISSING_FILES, payload)
    })
    this.storageService.on(StorageEvents.CHANNEL_DELETION_RESPONSE, (payload: { channelId: string }) => {
      this.logger(`Storage - ${StorageEvents.CHANNEL_DELETION_RESPONSE}`)
      this.serverIoProvider.io.emit(SocketActionTypes.CHANNEL_DELETION_RESPONSE, payload)
    })
    this.storageService.on(
      StorageEvents.REPLICATED_CSR,
      async (payload: { csrs: string[]; certificates: string[]; id: string }) => {
        this.logger(`Storage - ${StorageEvents.REPLICATED_CSR}`)
        this.libp2pService.emit(Libp2pEvents.DIAL_PEERS, await getLibp2pAddressesFromCsrs(payload.csrs))
        this.serverIoProvider.io.emit(SocketActionTypes.RESPONSE_GET_CSRS, { csrs: payload.csrs })
        this.registrationService.emit(RegistrationEvents.REGISTER_USER_CERTIFICATE, payload)
      }
    )

    this.socketService.on(SocketActionTypes.SEND_COMMUNITY_METADATA, async (payload: CommunityMetadata) => {
      await this.storageService?.updateCommunityMetadata(payload)
    })

    this.storageService.on(StorageEvents.COMMUNITY_METADATA_SAVED, async (meta: CommunityMetadata) => {
      this.logger(`Storage - ${StorageEvents.COMMUNITY_METADATA_SAVED}: ${meta}`)
      this.storageService?.updateMetadata(meta)
      this.serverIoProvider.io.emit(SocketActionTypes.COMMUNITY_METADATA_SAVED, meta)
    })
  }
}
