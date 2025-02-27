import { Inject, Injectable } from '@nestjs/common'
import {
  CertFieldsTypes,
  keyObjectFromString,
  verifySignature,
  parseCertificate,
  parseCertificationRequest,
  getCertFieldValue,
  getReqFieldValue,
} from '@quiet/identity'
import type { IPFS } from 'ipfs-core'
import EventStore from 'orbit-db-eventstore'
import KeyValueStore from 'orbit-db-kvstore'
import path from 'path'
import { EventEmitter } from 'events'
import PeerId from 'peer-id'
import { getCrypto } from 'pkijs'
import { stringToArrayBuffer } from 'pvutils'
import validate from '../validation/validators'
import { CID } from 'multiformats/cid'
import {
  ChannelMessage,
  CommunityMetadata,
  ConnectionProcessInfo,
  DeleteFilesFromChannelSocketPayload,
  FileMetadata,
  NoCryptoEngineError,
  PublicChannel,
  PushNotificationPayload,
  SaveCSRPayload,
  SaveCertificatePayload,
  SocketActionTypes,
  UserData,
} from '@quiet/types'
import { createLibp2pAddress, isDefined } from '@quiet/common'
import fs from 'fs'
import { IpfsFileManagerService } from '../ipfs-file-manager/ipfs-file-manager.service'
import { IPFS_REPO_PATCH, ORBIT_DB_DIR, QUIET_DIR } from '../const'
import { IpfsFilesManagerEvents } from '../ipfs-file-manager/ipfs-file-manager.types'
import { LocalDBKeys } from '../local-db/local-db.types'
import { LocalDbService } from '../local-db/local-db.service'
import { LazyModuleLoader } from '@nestjs/core'
import Logger from '../common/logger'
import { DirectMessagesRepo, PublicChannelsRepo } from '../common/types'
import { removeFiles, removeDirs, createPaths } from '../common/utils'
import { DBOptions, StorageEvents } from './storage.types'
import { CertificatesStore } from './certificates/certificates.store'
import { CertificatesRequestsStore } from './certifacteRequests/certificatesRequestsStore'
import { OrbitDb } from './orbitDb/orbitDb.service'
import { CommunityMetadataStore } from './communityMetadata/communityMetadata.store'

@Injectable()
export class StorageService extends EventEmitter {
  public publicChannelsRepos: Map<string, PublicChannelsRepo> = new Map()
  public directMessagesRepos: Map<string, DirectMessagesRepo> = new Map()
  private publicKeysMap: Map<string, CryptoKey> = new Map()

  public certificates: EventStore<string>
  public channels: KeyValueStore<PublicChannel>

  private ipfs: IPFS
  private filesManager: IpfsFileManagerService
  private peerId: PeerId | null = null
  private ipfsStarted: boolean

  private readonly logger = Logger(StorageService.name)

  constructor(
    @Inject(QUIET_DIR) public readonly quietDir: string,
    @Inject(ORBIT_DB_DIR) public readonly orbitDbDir: string,
    @Inject(IPFS_REPO_PATCH) public readonly ipfsRepoPath: string,
    private readonly localDbService: LocalDbService,
    private readonly orbitDbService: OrbitDb,
    private readonly certificatesRequestsStore: CertificatesRequestsStore,
    private readonly certificatesStore: CertificatesStore,
    private readonly communityMetadataStore: CommunityMetadataStore,
    private readonly lazyModuleLoader: LazyModuleLoader
  ) {
    super()
  }

  private prepare() {
    this.logger('Initializing storage')
    removeFiles(this.quietDir, 'LOCK')
    removeDirs(this.quietDir, 'repo.lock')
    this.ipfsStarted = false

    if (!['android', 'ios'].includes(process.platform)) {
      createPaths([this.ipfsRepoPath, this.orbitDbDir])
    }

    this.emit(SocketActionTypes.CONNECTION_PROCESS_INFO, ConnectionProcessInfo.INITIALIZED_STORAGE)

    this.logger('Initialized storage')
  }

  public async init(peerId: any) {
    this.clean()
    this.prepare()
    this.peerId = peerId
    const { IpfsModule } = await import('../ipfs/ipfs.module')
    const ipfsModuleRef = await this.lazyModuleLoader.load(() => IpfsModule)
    const { IpfsService } = await import('../ipfs/ipfs.service')
    const ipfsService = ipfsModuleRef.get(IpfsService)
    await ipfsService.createInstance(peerId)
    const ipfsInstance = ipfsService?.ipfsInstance
    if (!ipfsInstance) {
      this.logger.error('no ipfs instance')
      throw new Error('no ipfs instance')
    }
    this.ipfs = ipfsInstance
    await this.orbitDbService.create(peerId, this.ipfs)

    this.emit(SocketActionTypes.CONNECTION_PROCESS_INFO, ConnectionProcessInfo.INITIALIZING_IPFS)

    const { IpfsFileManagerModule } = await import('../ipfs-file-manager/ipfs-file-manager.module')
    const ipfsFileManagerModuleRef = await this.lazyModuleLoader.load(() => IpfsFileManagerModule)
    const { IpfsFileManagerService } = await import('../ipfs-file-manager/ipfs-file-manager.service')
    const ipfsFileManagerService = ipfsFileManagerModuleRef.get(IpfsFileManagerService)
    await ipfsFileManagerService.init()
    this.filesManager = ipfsFileManagerService

    this.attachFileManagerEvents()
    await this.initDatabases()

    void this.startIpfs()
  }

  private async startIpfs() {
    this.logger('Starting IPFS')
    return this.ipfs
      .start()
      .then(async () => {
        this.logger('IPFS started')
        this.ipfsStarted = true
        try {
          await this.startReplicate()
        } catch (e) {
          console.log(`Couldn't start store replication`)
        }
      })
      .catch((e: Error) => {
        console.log(`Couldn't start ipfs node`, e.message)
        throw new Error(e.message)
      })
  }

  private async startReplicate() {
    const dbs = []

    if (this.channels?.address) {
      dbs.push(this.channels.address)
    }
    if (this.certificatesStore.getAddress()) {
      dbs.push(this.certificatesStore.getAddress())
    }
    if (this.certificatesRequestsStore.getAddress()) {
      dbs.push(this.certificatesRequestsStore.getAddress())
    }
    if (this.communityMetadataStore?.getAddress()) {
      dbs.push(this.communityMetadataStore.getAddress())
    }

    const channels = this.publicChannelsRepos.values()

    for (const channel of channels) {
      dbs.push(channel.db.address)
    }

    const addresses = dbs.map(db => StorageService.dbAddress(db))
    await this.subscribeToPubSub(addresses)
  }

  static dbAddress = (db: { root: string; path: string }) => {
    // Note: Do not use path.join for creating db address!
    return `/orbitdb/${db.root}/${db.path}`
  }

  public async initDatabases() {
    this.logger('1/3')
    console.time('Storage.initDatabases')

    await this.communityMetadataStore.init(this)
    await this.certificatesStore.init(this)
    await this.certificatesRequestsStore.init(this)

    this.logger('2/3')
    await this.attachCertificatesStoreListeners()
    await this.attachCsrsStoreListeners()

    this.logger('3/3')
    await this.createDbForChannels()
    await this.initAllChannels()

    console.timeEnd('Storage.initDatabases')
    this.logger('Initialized DBs')

    this.emit(SocketActionTypes.CONNECTION_PROCESS_INFO, ConnectionProcessInfo.INITIALIZED_DBS)
  }

  private async subscribeToPubSub(addr: string[]) {
    if (!this.ipfsStarted) {
      this.logger(`IPFS not started. Not subscribing to ${addr}`)
      return
    }
    for (const a of addr) {
      this.logger(`Pubsub - subscribe to ${a}`)
      // @ts-ignore
      await this.orbitDbService.orbitDb._pubsub.subscribe(
        a,
        // @ts-ignore
        this.orbitDbService.orbitDb._onMessage.bind(this.orbitDbService.orbitDb),
        // @ts-ignore
        this.orbitDbService.orbitDb._onPeerConnected.bind(this.orbitDbService.orbitDb)
      )
    }
  }

  private async __stopIPFS() {
    if (this.ipfs) {
      this.logger('Stopping IPFS files manager')
      try {
        await this.filesManager.stop()
      } catch (e) {
        this.logger.error('cannot stop filesManager')
      }
      this.logger('Stopping IPFS')
      try {
        await this.ipfs.stop()
      } catch (err) {
        this.logger.error(`Following error occured during closing ipfs database: ${err as string}`)
      }
      this.ipfsStarted = false
    }
  }

  public async stopOrbitDb() {
    try {
      await this.channels?.close()
    } catch (e) {
      this.logger.error('Error closing channels db', e)
    }

    try {
      await this.certificatesStore?.close()
    } catch (e) {
      this.logger.error('Error closing certificates db', e)
    }

    try {
      await this.certificatesRequestsStore?.close()
    } catch (e) {
      this.logger.error('Error closing certificates db', e)
    }

    try {
      await this.communityMetadataStore?.close()
    } catch (e) {
      this.logger.error('Error closing community metadata store', e)
    }

    await this.orbitDbService.stop()
    await this.__stopIPFS()
  }

  public async updateCommunityMetadata(communityMetadata: CommunityMetadata) {
    await this.communityMetadataStore?.updateCommunityMetadata(communityMetadata)
  }

  public updateMetadata(meta: CommunityMetadata) {
    this.certificatesStore.updateMetadata(meta)
  }

  public async updatePeersList() {
    const users = this.getAllUsers()
    const peers = users.map(peer => createLibp2pAddress(peer.onionAddress, peer.peerId))
    console.log('updatePeersList, peers count:', peers.length)
    const community = await this.localDbService.get(LocalDBKeys.COMMUNITY)
    const sortedPeers = await this.localDbService.getSortedPeers(peers)
    if (sortedPeers.length > 0) {
      community.peers = sortedPeers
      await this.localDbService.put(LocalDBKeys.COMMUNITY, community)
    }
    this.emit(StorageEvents.UPDATE_PEERS_LIST, { communityId: community.id, peerList: peers })
  }

  public async loadAllCertificates() {
    this.logger('Loading all certificates')
    this.emit(StorageEvents.REPLICATED_CERTIFICATES, {
      certificates: await this.certificatesStore.loadAllCertificates(),
    })
  }

  public async attachCertificatesStoreListeners() {
    this.on(StorageEvents.LOADED_CERTIFICATES, async payload => {
      this.emit(StorageEvents.REPLICATED_CERTIFICATES, payload)
      await this.updatePeersList()
    })
  }

  public async attachCsrsStoreListeners() {
    this.on(StorageEvents.LOADED_USER_CSRS, async payload => {
      const allCertificates = this.getAllEventLogEntries(this.certificatesStore.store)
      this.emit(StorageEvents.REPLICATED_CSR, { csrs: payload.csrs, certificates: allCertificates, id: payload.id })
      // TODO
      await this.updatePeersList()
    })
  }

  public resolveCsrReplicatedPromise(id: number) {
    this.certificatesRequestsStore.resolveCsrReplicatedPromise(id)
  }

  public async loadAllChannels() {
    this.logger('Getting all channels')
    // @ts-expect-error - OrbitDB's type declaration of `load` lacks 'options'
    await this.channels.load({ fetchEntryTimeout: 2000 })
    this.emit(StorageEvents.LOAD_PUBLIC_CHANNELS, {
      channels: this.channels.all as unknown as { [key: string]: PublicChannel },
    })
  }

  private async createDbForChannels() {
    this.logger('createDbForChannels init')
    this.channels = await this.orbitDbService.orbitDb.keyvalue<PublicChannel>('public-channels', {
      replicate: false,
      accessController: {
        // type: 'channelsaccess',
        write: ['*'],
      },
    })

    this.channels.events.on('write', async (_address, entry) => {
      this.logger('WRITE: Channels')
    })

    this.channels.events.on('replicated', async () => {
      this.logger('REPLICATED: Channels')
      this.emit(SocketActionTypes.CONNECTION_PROCESS_INFO, ConnectionProcessInfo.CHANNELS_REPLICATED)
      // @ts-expect-error - OrbitDB's type declaration of `load` lacks 'options'
      await this.channels.load({ fetchEntryTimeout: 2000 })

      const channels = Object.values(this.channels.all)

      const keyValueChannels: {
        [key: string]: PublicChannel
      } = {}

      channels.forEach(channel => {
        keyValueChannels[channel.id] = channel
      })

      this.emit(StorageEvents.LOAD_PUBLIC_CHANNELS, {
        channels: keyValueChannels,
      })

      channels.forEach(async (channel: PublicChannel) => {
        await this.subscribeToChannel(channel, { replicate: true })
      })
    })

    // @ts-expect-error - OrbitDB's type declaration of `load` lacks 'options'
    await this.channels.load({ fetchEntryTimeout: 1000 })
    this.logger('Channels count:', Object.keys(this.channels.all).length)
    this.logger('Channels names:', Object.keys(this.channels.all))
    Object.values(this.channels.all).forEach(async (channel: PublicChannel) => {
      await this.subscribeToChannel(channel)
    })
    this.logger('STORAGE: Finished createDbForChannels')
  }

  async initAllChannels() {
    this.emit(StorageEvents.LOAD_PUBLIC_CHANNELS, {
      channels: this.channels.all as unknown as { [key: string]: PublicChannel },
    })
  }

  async verifyMessage(message: ChannelMessage): Promise<boolean> {
    const crypto = getCrypto()
    if (!crypto) throw new NoCryptoEngineError()

    const signature = stringToArrayBuffer(message.signature)
    let cryptoKey = this.publicKeysMap.get(message.pubKey)

    if (!cryptoKey) {
      cryptoKey = await keyObjectFromString(message.pubKey, crypto)
      this.publicKeysMap.set(message.pubKey, cryptoKey)
    }

    return await verifySignature(signature, message.message, cryptoKey)
  }

  protected getAllEventLogEntries<T>(db: EventStore<T>): T[] {
    return db
      .iterator({ limit: -1 })
      .collect()
      .map(e => e.payload.value)
  }

  protected getAllEventLogRawEntries<T>(db: EventStore<T>) {
    return db.iterator({ limit: -1 }).collect()
  }

  public async subscribeToChannel(channelData: PublicChannel, options = { replicate: false }): Promise<void> {
    let db: EventStore<ChannelMessage>
    // @ts-ignore
    if (channelData.address) {
      // @ts-ignore
      channelData.id = channelData.address
    }
    let repo = this.publicChannelsRepos.get(channelData.id)
    if (repo) {
      db = repo.db
    } else {
      try {
        db = await this.createChannel(channelData, options)
      } catch (e) {
        this.logger.error(`Can't subscribe to channel ${channelData.id}`, e.message)
        return
      }
      if (!db) {
        this.logger(`Can't subscribe to channel ${channelData.id}`)
        return
      }
      repo = this.publicChannelsRepos.get(channelData.id)
    }

    if (repo && !repo.eventsAttached) {
      this.logger('Subscribing to channel ', channelData.id)

      db.events.on('write', async (_address, entry) => {
        this.logger(`Writing to public channel db ${channelData.id}`)
        const verified = await this.verifyMessage(entry.payload.value)

        this.emit(StorageEvents.LOAD_MESSAGES, {
          messages: [entry.payload.value],
          isVerified: verified,
        })
      })

      db.events.on('replicate.progress', async (address, _hash, entry, progress, total) => {
        this.logger(`progress ${progress as string}/${total as string}. Address: ${address as string}`)
        const messages = [entry.payload.value]

        const verified = await this.verifyMessage(messages[0])

        const message = messages[0]

        this.emit(StorageEvents.LOAD_MESSAGES, {
          messages: [message],
          isVerified: verified,
        })

        // Display push notifications on mobile
        if (process.env.BACKEND === 'mobile') {
          if (!verified) return

          // Do not notify about old messages
          // @ts-ignore
          if (parseInt(message.createdAt) < parseInt(process.env.CONNECTION_TIME || '')) return

          const username = await this.certificatesStore.getCertificateUsername(message.pubKey)
          if (!username) {
            this.logger.error(`Can't send push notification, no username found for public key '${message.pubKey}'`)
            return
          }

          const payload: PushNotificationPayload = {
            message: JSON.stringify(message),
            username: username,
          }

          this.emit(StorageEvents.SEND_PUSH_NOTIFICATION, payload)
        }
      })
      db.events.on('replicated', async address => {
        this.logger('Replicated.', address)
        const ids = this.getAllEventLogEntries<ChannelMessage>(db).map(msg => msg.id)
        const community = await this.localDbService.get(LocalDBKeys.COMMUNITY)
        this.emit(StorageEvents.SEND_MESSAGES_IDS, {
          ids,
          channelId: channelData.id,
          communityId: community.id,
        })
      })
      db.events.on('ready', async () => {
        const ids = this.getAllEventLogEntries<ChannelMessage>(db).map(msg => msg.id)
        const community = await this.localDbService.get(LocalDBKeys.COMMUNITY)
        this.emit(StorageEvents.SEND_MESSAGES_IDS, {
          ids,
          channelId: channelData.id,
          communityId: community.id,
        })
      })
      await db.load()
      repo.eventsAttached = true
    }

    this.logger(`Subscribed to channel ${channelData.id}`)
    this.emit(StorageEvents.SET_CHANNEL_SUBSCRIBED, {
      channelId: channelData.id,
    })
  }

  public async askForMessages(channelId: string, ids: string[]) {
    const repo = this.publicChannelsRepos.get(channelId)
    if (!repo) return
    const messages = this.getAllEventLogEntries<ChannelMessage>(repo.db)
    const filteredMessages: ChannelMessage[] = []
    for (const id of ids) {
      filteredMessages.push(...messages.filter(i => i.id === id))
    }
    this.emit(StorageEvents.LOAD_MESSAGES, {
      messages: filteredMessages,
      isVerified: true,
    })
    const community = await this.localDbService.get(LocalDBKeys.COMMUNITY)
    this.emit(StorageEvents.CHECK_FOR_MISSING_FILES, community.id)
  }

  private async createChannel(data: PublicChannel, options: DBOptions): Promise<EventStore<ChannelMessage>> {
    console.log('creating channel')
    if (!validate.isChannel(data)) {
      this.logger.error('STORAGE: Invalid channel format')
      throw new Error('Create channel validation error')
    }
    this.logger(`Creating channel ${data.id}`)

    const channelId = data.id

    const db: EventStore<ChannelMessage> = await this.orbitDbService.orbitDb.log<ChannelMessage>(
      `channels.${channelId}`,
      {
        replicate: options.replicate,
        accessController: {
          type: 'messagesaccess',
          write: ['*'],
        },
      }
    )

    const channel = this.channels.get(channelId)
    console.log('channel', channel)
    if (channel === undefined) {
      await this.channels.put(channelId, {
        ...data,
      })
      console.log('emitting new channel')
      this.emit(StorageEvents.CREATED_CHANNEL, {
        channel: data,
      })
    }

    this.publicChannelsRepos.set(channelId, { db, eventsAttached: false })
    this.logger(`Set ${channelId} to local channels`)
    // @ts-expect-error - OrbitDB's type declaration of `load` lacks 'options'
    await db.load({ fetchEntryTimeout: 2000 })
    this.logger(`Created channel ${channelId}`)
    await this.subscribeToPubSub([StorageService.dbAddress(db.address)])
    return db
  }

  public async deleteChannel(payload: { channelId: string; ownerPeerId: string }) {
    console.log('deleting channel storage', payload)
    const { channelId, ownerPeerId } = payload
    // @ts-expect-error - OrbitDB's type declaration of `load` lacks 'options'
    await this.channels.load({ fetchEntryTimeout: 15000 })
    const channel = this.channels.get(channelId)
    if (!this.peerId) {
      this.logger('deleteChannel - peerId is null')
      throw new Error('deleteChannel - peerId is null')
    }
    const isOwner = ownerPeerId === this.peerId.toString()
    if (channel && isOwner) {
      await this.channels.del(channelId)
    }
    let repo = this.publicChannelsRepos.get(channelId)
    if (!repo) {
      const db = await this.orbitDbService.orbitDb.log<ChannelMessage>(`channels.${channelId}`, {
        accessController: {
          type: 'messagesaccess',
          write: ['*'],
        },
      })
      repo = {
        db,
        eventsAttached: false,
      }
    }
    await repo.db.load()
    const allEntries = this.getAllEventLogRawEntries(repo.db)
    await repo.db.close()
    await repo.db.drop()
    const hashes = allEntries.map(e => CID.parse(e.hash))
    const files = allEntries
      .map(e => {
        return e.payload.value.media
      })
      .filter(isDefined)
    // await this.deleteChannelFiles(files)
    // await this.deleteChannelMessages(hashes)
    this.publicChannelsRepos.delete(channelId)
    const responsePayload = { channelId: payload.channelId }
    this.emit(StorageEvents.CHANNEL_DELETION_RESPONSE, responsePayload)
  }

  public async deleteChannelFiles(files: FileMetadata[]) {
    for (const file of files) {
      await this.deleteFile(file)
    }
  }

  public async deleteFile(fileMetadata: FileMetadata) {
    await this.filesManager.deleteBlocks(fileMetadata)
  }

  public async deleteChannelMessages(hashes: CID[]) {
    console.log('hashes ', hashes)
    const gcresult = this.ipfs.repo.gc()
    for await (const res of gcresult) {
      // @ts-ignore
      // const ccc = base58.base58btc.encode(res.cid?.multihash.bytes)
      // console.log('base58btc encoded', ccc)
      // console.log('garbage collector result', res)
    }
    // for await (const result of this.ipfs.block.rm(hashes)) {
    //   if (result.error) {
    //     console.error(`Failed to remove block ${result.cid} due to ${result.error.message}`)
    //   }
    // }
  }

  public async sendMessage(message: ChannelMessage) {
    if (!validate.isMessage(message)) {
      this.logger.error('STORAGE: public channel message is invalid')
      return
    }
    const repo = this.publicChannelsRepos.get(message.channelId)
    if (!repo) {
      this.logger.error(`Could not send message. No '${message.channelId}' channel in saved public channels`)
      return
    }
    try {
      await repo.db.add(message)
    } catch (e) {
      this.logger.error(
        `STORAGE: Could not append message (entry not allowed to write to the log). Details: ${e.message}`
      )
    }
  }

  private attachFileManagerEvents = () => {
    this.filesManager.on(IpfsFilesManagerEvents.UPDATE_DOWNLOAD_PROGRESS, status => {
      this.emit(StorageEvents.UPDATE_DOWNLOAD_PROGRESS, status)
    })
    this.filesManager.on(IpfsFilesManagerEvents.UPDATE_MESSAGE_MEDIA, messageMedia => {
      this.emit(StorageEvents.UPDATE_MESSAGE_MEDIA, messageMedia)
    })
    this.filesManager.on(StorageEvents.REMOVE_DOWNLOAD_STATUS, payload => {
      this.emit(StorageEvents.REMOVE_DOWNLOAD_STATUS, payload)
    })
    this.filesManager.on(StorageEvents.UPLOADED_FILE, payload => {
      this.emit(StorageEvents.UPLOADED_FILE, payload)
    })
    this.filesManager.on(StorageEvents.UPDATE_DOWNLOAD_PROGRESS, payload => {
      this.emit(StorageEvents.UPDATE_DOWNLOAD_PROGRESS, payload)
    })
    this.filesManager.on(StorageEvents.UPDATE_MESSAGE_MEDIA, payload => {
      this.emit(StorageEvents.UPDATE_MESSAGE_MEDIA, payload)
    })
  }

  public async uploadFile(metadata: FileMetadata) {
    this.filesManager.emit(IpfsFilesManagerEvents.UPLOAD_FILE, metadata)
  }

  public async downloadFile(metadata: FileMetadata) {
    this.filesManager.emit(IpfsFilesManagerEvents.DOWNLOAD_FILE, metadata)
  }

  public cancelDownload(mid: string) {
    this.filesManager.emit(IpfsFilesManagerEvents.CANCEL_DOWNLOAD, mid)
  }

  public async saveCertificate(payload: SaveCertificatePayload): Promise<boolean> {
    this.logger('About to save certificate...')
    if (!payload.certificate) {
      this.logger('Certificate is either null or undefined, not saving to db')
      return false
    }
    this.logger('Saving certificate...')
    const result = await this.certificatesStore.addCertificate(payload.certificate)
    return result
  }

  public async saveCSR(payload: SaveCSRPayload): Promise<boolean> {
    const result = await this.certificatesRequestsStore.addUserCsr(payload.csr)
    return result
  }

  public getAllUsers(): UserData[] {
    const csrs = this.getAllEventLogEntries(this.certificatesRequestsStore.store)
    this.logger('csrs count:', csrs.length)
    const allUsers: UserData[] = []
    for (const csr of csrs) {
      const parsedCert = parseCertificationRequest(csr)
      const onionAddress = getReqFieldValue(parsedCert, CertFieldsTypes.commonName)
      const peerId = getReqFieldValue(parsedCert, CertFieldsTypes.peerId)
      const username = getReqFieldValue(parsedCert, CertFieldsTypes.nickName)
      const dmPublicKey = getReqFieldValue(parsedCert, CertFieldsTypes.dmPublicKey)
      if (!onionAddress || !peerId || !username || !dmPublicKey) continue
      allUsers.push({ onionAddress, peerId, username, dmPublicKey })
    }
    return allUsers
  }

  public usernameCert(username: string): string | null {
    /**
     * Check if given username is already in use
     */
    const certificates = this.getAllEventLogEntries(this.certificatesStore.store)
    for (const cert of certificates) {
      const parsedCert = parseCertificate(cert)
      const certUsername = getCertFieldValue(parsedCert, CertFieldsTypes.nickName)
      if (certUsername?.localeCompare(username, 'en', { sensitivity: 'base' }) === 0) {
        return cert
      }
    }
    return null
  }

  public async deleteFilesFromChannel(payload: DeleteFilesFromChannelSocketPayload) {
    const { messages } = payload
    Object.keys(messages).map(async key => {
      const message = messages[key]
      if (message?.media?.path) {
        const mediaPath = message.media.path
        this.logger('deleteFilesFromChannel : mediaPath', mediaPath)
        const isFileExist = await this.checkIfFileExist(mediaPath)
        this.logger(`deleteFilesFromChannel : isFileExist- ${isFileExist}`)
        if (isFileExist) {
          fs.unlink(mediaPath, unlinkError => {
            if (unlinkError) {
              this.logger(`deleteFilesFromChannel : unlink error - ${unlinkError}`)
            }
          })
        } else {
          this.logger(`deleteFilesFromChannel : file dont exist - ${mediaPath}`)
        }
      }
    })
  }

  public async checkIfFileExist(filepath: string): Promise<boolean> {
    return await new Promise(resolve => {
      fs.access(filepath, fs.constants.F_OK, error => {
        resolve(!error)
      })
    })
  }

  public resetCsrAndCertsValues() {
    this.certificatesRequestsStore.resetCsrReplicatedMapAndId()
    this.certificatesStore.resetValues()
  }

  private clean() {
    // @ts-ignore
    this.channels = undefined
    // @ts-ignore
    this.messageThreads = undefined
    // @ts-ignore
    this.publicChannelsRepos = new Map()
    this.directMessagesRepos = new Map()
    this.publicKeysMap = new Map()
    // @ts-ignore
    this.ipfs = null
    // @ts-ignore
    this.filesManager = null
    this.peerId = null

    this.resetCsrAndCertsValues()
  }
}
