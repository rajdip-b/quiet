import { type PayloadAction } from '@reduxjs/toolkit'
import { put, select } from 'typed-redux-saga'
import { type Socket } from '../../../types'
import { publicChannelsActions } from '../../publicChannels/publicChannels.slice'
import { communitiesSelectors } from '../communities.selectors'
import { communitiesActions } from '../communities.slice'

export function* saveCommunityMetadataSaga(
  socket: Socket,
  action: PayloadAction<ReturnType<typeof communitiesActions.saveCommunityMetadata>['payload']>
): Generator {
  const communityId = yield* select(communitiesSelectors.currentCommunityId)
  console.log('save community metadata', action.payload)
  yield* put(
    communitiesActions.updateCommunity({
      id: communityId,
      rootCa: action.payload.rootCa,
      ownerOrbitDbIdentity: action.payload.ownerOrbitDbIdentity,
      ownerCertificate: action.payload.ownerCertificate,
    })
  )

  yield* put(publicChannelsActions.sendUnregisteredInfoMessage())
}
