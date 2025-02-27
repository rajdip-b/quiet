import fs from 'fs'
import { jest } from '@jest/globals'
import { create, IPFS } from 'ipfs-core'
import { CertificatesRequestsStore } from './certificatesRequestsStore'
import { EventEmitter } from 'events'
import { StorageEvents } from '../storage.types'
import { TestConfig } from '../../const'
import { Test, TestingModule } from '@nestjs/testing'
import { TestModule } from '../../common/test.module'
import { StorageModule } from '../storage.module'
import { OrbitDb } from '../orbitDb/orbitDb.service'
import PeerId from 'peer-id'

const replicatedEvent = async (certificatesRequestsStore: any) => {
  certificatesRequestsStore.events.emit('replicated')
  await new Promise<void>(resolve => setTimeout(() => resolve(), 2000))
}

describe('CertificatesRequestsStore', () => {
  let module: TestingModule
  let certificatesRequestsStore: CertificatesRequestsStore
  let orbitDb: OrbitDb
  let ipfs: IPFS

  beforeEach(async () => {
    jest.clearAllMocks()

    module = await Test.createTestingModule({
      imports: [TestModule, StorageModule],
    }).compile()

    certificatesRequestsStore = await module.resolve(CertificatesRequestsStore)

    orbitDb = await module.resolve(OrbitDb)
    const peerId = await PeerId.create()
    ipfs = await create()
    await orbitDb.create(peerId, ipfs)

    const emitter = new EventEmitter()
    await certificatesRequestsStore.init(emitter)
  })

  afterEach(async () => {
    await orbitDb.stop()
    await ipfs.stop()
    await certificatesRequestsStore.close()
    if (fs.existsSync(TestConfig.ORBIT_DB_DIR)) {
      fs.rmSync(TestConfig.ORBIT_DB_DIR, { recursive: true })
    }
  })

  it('validateUserCs, correct csr', async () => {
    const cert =
      'MIIDITCCAsYCAQAwSTFHMEUGA1UEAxM+anR3c3hxMnZ1dWthY3JodWhvdnAzd2JxbzRxNXc0d2s3Nm1qbWJ3cXk3eGNma2FsdmRxb3hhYWQub25pb24wWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQE2q6iS+WCmIVCSFI2AjHrW6ujUdrceD5T2xkcTJBTn0y50WphcupUajCRgkXaTBkTsGNJ3qWRZAKX7CiuehBJoIICGTAuBgkqhkiG9w0BCQ4xITAfMB0GA1UdDgQWBBQuE5JgPY/BYBpgG5pnjMkEEIkrGjCCAUcGCSqGSIb3DQEJDDGCATgEggE0BDlx84glBl72q82F2a+y8iTVKM8IMiXYYrmNyhFPj6XsfVQpvLhNviZ5zHdMBWbFj44vTSUIasNP9I9eCWSEAaEJqjngEh18WCRS/XbvQxI/8qB5pzcfghvM8BCgSLbSEjK2GMYVhCXmRH1YGHIZu0+Ii9pe5nwG154JlPUsmIRgu6ruY6PQk65Aoo4OyhPn5CCUFInptHcz1JpAiCRe0Z6wuQHud03VY50fx4ETdmUNJBEIPOyd/Xn6lMOi6SaWGHbCWiufeJRm+mRdoHJAEt6kPLhGIYGyduNT/8cGoe2xKyQDvNoTr4dqqRZ2HgZ18nicsTHswpGqAlUnZXaA3V85Qu1cvaMAqEoPOUlGP9AriIVwtIZM0hdWHqKHgBCZrKfHb5oLxt6ourQ3+q19tvx+u6UwFAYKKwYBBAGDjBsCATEGEwRlbGxvMD0GCSsGAQIBDwMBATEwEy5RbVVvNXN0NXNqR3RFMUtQeXhOVW5pTWhnQXduV0JVNXk3TnpoMlpRRkdacVdiMEcGA1UdETFAEz5qdHdzeHEydnV1a2Fjcmh1aG92cDN3YnFvNHE1dzR3azc2bWptYndxeTd4Y2ZrYWx2ZHFveGFhZC5vbmlvbjAKBggqhkjOPQQDAgNJADBGAiEAt9udw7B7vnjJyWvkkRLb7DImFXwsrSxirqbmhIH+1rUCIQD86GWyfAE2d8gCNAn4h1t9B+mAx33ZdPLgFssHl1i3pA=='
    const result = await CertificatesRequestsStore.validateUserCsr(cert)
    expect(result).toBe(true)
  })

  it('validateUserCsr, malformed string', async () => {
    const cert = 'notACsr'
    const result = await CertificatesRequestsStore.validateUserCsr(cert)
    expect(result).toBe(false)
  })

  it('getCsrs - remove old csrs and replace with new for each pubkey', async () => {
    const emitter = new EventEmitter()
    await certificatesRequestsStore.init(emitter)

    const allCsrs = [
      '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',
    ]

    for (const csr of allCsrs) {
      await certificatesRequestsStore.addUserCsr(csr)
      // This should not be there, there's bug in orbitdb, it breaks if we add entries without artificial sleep, tho it's awaited.
      // https://github.com/TryQuiet/quiet/issues/2121
      await new Promise<void>(resolve => setTimeout(() => resolve(), 500))
    }

    await certificatesRequestsStore.getCsrs()

    const filteredCsrs = await certificatesRequestsStore.getCsrs()

    expect(filteredCsrs.length).toEqual(allCsrs.length - 1)
    expect(filteredCsrs).toEqual([
      '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',
    ])
  })
  it('replicated event', async () => {
    const emitter = new EventEmitter()
    await certificatesRequestsStore.init(emitter)

    const spy = jest.fn()

    emitter.on(StorageEvents.LOADED_USER_CSRS, spy)
    await replicatedEvent(certificatesRequestsStore.store)

    expect(spy).toBeCalledTimes(1)
  })
  it('2 replicated events - first not resolved ', async () => {
    const emitter = new EventEmitter()
    await certificatesRequestsStore.init(emitter)

    const spy = jest.fn()

    emitter.on(StorageEvents.LOADED_USER_CSRS, spy)
    await replicatedEvent(certificatesRequestsStore.store)
    await replicatedEvent(certificatesRequestsStore.store)

    expect(spy).toBeCalledTimes(1)
  })
  it('2 replicated events - first resolved ', async () => {
    const emitter = new EventEmitter()
    await certificatesRequestsStore.init(emitter)

    const spy = jest.fn()

    emitter.on(StorageEvents.LOADED_USER_CSRS, spy)
    await replicatedEvent(certificatesRequestsStore.store)
    await replicatedEvent(certificatesRequestsStore.store)

    certificatesRequestsStore.resolveCsrReplicatedPromise(1)
    await new Promise<void>(resolve => setTimeout(() => resolve(), 500))

    expect(spy).toBeCalledTimes(2)
  })
  it('3 replicated events - no resolved promises', async () => {
    const emitter = new EventEmitter()
    await certificatesRequestsStore.init(emitter)

    const spy = jest.fn()

    emitter.on(StorageEvents.LOADED_USER_CSRS, spy)
    await replicatedEvent(certificatesRequestsStore.store)
    await replicatedEvent(certificatesRequestsStore.store)
    await replicatedEvent(certificatesRequestsStore.store)

    expect(spy).toBeCalledTimes(1)
  })
  it('3 replicated events - two resolved promises ', async () => {
    const emitter = new EventEmitter()
    await certificatesRequestsStore.init(emitter)

    const spy = jest.fn()
    emitter.on(StorageEvents.LOADED_USER_CSRS, spy)

    await replicatedEvent(certificatesRequestsStore.store)
    await replicatedEvent(certificatesRequestsStore.store)
    certificatesRequestsStore.resolveCsrReplicatedPromise(1)
    await new Promise<void>(resolve => setTimeout(() => resolve(), 500))
    await replicatedEvent(certificatesRequestsStore.store)
    certificatesRequestsStore.resolveCsrReplicatedPromise(2)
    await new Promise<void>(resolve => setTimeout(() => resolve(), 500))

    expect(spy).toBeCalledTimes(3)
  })
})
