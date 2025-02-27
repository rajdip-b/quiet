import { Injectable, OnModuleInit } from '@nestjs/common'
import { EventEmitter } from 'events'
import { extractPendingCsrs, issueCertificate } from './registration.functions'
import { ErrorCodes, ErrorMessages, PermsData, RegisterOwnerCertificatePayload, SocketActionTypes } from '@quiet/types'
import { RegistrationEvents } from './registration.types'
import Logger from '../common/logger'

@Injectable()
export class RegistrationService extends EventEmitter implements OnModuleInit {
  private readonly logger = Logger(RegistrationService.name)
  public certificates: string[] = []
  private _permsData: PermsData

  constructor() {
    super()
  }

  onModuleInit() {
    this.on(
      RegistrationEvents.REGISTER_USER_CERTIFICATE,
      async (payload: { csrs: string[]; certificates: string[]; id: string }) => {
        await this.issueCertificates(payload)
      }
    )
  }

  private async issueCertificates(payload: { csrs: string[]; certificates: string[]; id?: string }) {
    // Lack of permsData means that we are not the owner of the
    // community in the official model of the app, however anyone can
    // modify the source code, put malicious permsData here, issue
    // false certificates and try to trick other users. To prevent
    // that, peers verify that anything that is written to the
    // certificate store is signed by the owner.
    if (!this._permsData) {
      if (payload.id) this.emit(RegistrationEvents.FINISHED_ISSUING_CERTIFICATES_FOR_ID, { id: payload.id })
      return
    }

    this.logger('DuplicatedCertBug', { payload })
    const pendingCsrs = await extractPendingCsrs(payload)
    this.logger('DuplicatedCertBug', { pendingCsrs })
    await Promise.all(
      pendingCsrs.map(async csr => {
        await this.registerUserCertificate(csr)
      })
    )

    if (payload.id) this.emit(RegistrationEvents.FINISHED_ISSUING_CERTIFICATES_FOR_ID, { id: payload.id })
  }

  public set permsData(perms: PermsData) {
    this._permsData = {
      certificate: perms.certificate,
      privKey: perms.privKey,
    }
  }

  public async registerOwnerCertificate(payload: RegisterOwnerCertificatePayload): Promise<void> {
    this._permsData = payload.permsData
    const result = await issueCertificate(payload.userCsr.userCsr, this._permsData)
    if (result?.cert) {
      this.emit(SocketActionTypes.SAVED_OWNER_CERTIFICATE, {
        communityId: payload.communityId,
        network: { certificate: result.cert },
      })
    } else {
      this.emit(SocketActionTypes.ERROR, {
        type: SocketActionTypes.REGISTER_OWNER_CERTIFICATE,
        code: ErrorCodes.SERVER_ERROR,
        message: ErrorMessages.REGISTRATION_FAILED,
        community: payload.communityId,
      })
    }
  }

  public async registerUserCertificate(csr: string): Promise<void> {
    const result = await issueCertificate(csr, this._permsData)
    this.logger('DuplicatedCertBug', { result })
    if (result?.cert) {
      this.emit(RegistrationEvents.NEW_USER, { certificate: result.cert })
    }
  }
}
