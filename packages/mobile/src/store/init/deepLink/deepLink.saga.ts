import { PayloadAction } from '@reduxjs/toolkit'
import { select, delay, put } from 'typed-redux-saga'
import { communities, getInvitationCodes } from '@quiet/state-manager'
import { ScreenNames } from '../../../const/ScreenNames.enum'
import { navigationActions } from '../../navigation/navigation.slice'
import { initSelectors } from '../init.selectors'
import { initActions } from '../init.slice'
import { appImages } from '../../../assets'
import { replaceScreen } from '../../../RootNavigation'
import { CommunityOwnership, CreateNetworkPayload, InvitationData } from '@quiet/types'

export function* deepLinkSaga(action: PayloadAction<ReturnType<typeof initActions.deepLink>['payload']>): Generator {
  const code = action.payload

  console.log('INIT_NAVIGATION: Waiting for websocket connection before proceeding with deep link flow.')

  while (true) {
    const connected = yield* select(initSelectors.isWebsocketConnected)
    if (connected) {
      break
    }
    yield* delay(500)
  }

  console.log('INIT_NAVIGATION: Continuing on deep link flow.')

  // Reset deep link flag for future redirections sake
  yield* put(initActions.resetDeepLink())

  const community = yield* select(communities.selectors.currentCommunity)

  // Link opened mid registration
  // TODO: Check if csr is already saved to db (redux store)

  // User already belongs to a community
  if (community) {
    console.log('INIT_NAVIGATION: Displaying error (user already belongs to a community).')
    yield* put(
      navigationActions.replaceScreen({
        screen: ScreenNames.ErrorScreen,
        params: {
          onPress: () => replaceScreen(ScreenNames.ChannelListScreen),
          icon: appImages.quiet_icon_round,
          title: 'You already belong to a community',
          message: "We're sorry but for now you can only be a member of a single community at a time",
        },
      })
    )
    return
  }

  let data: InvitationData
  try {
    data = getInvitationCodes(code)
  } catch (e) {
    console.warn(e.message)
    yield* put(
      navigationActions.replaceScreen({
        screen: ScreenNames.ErrorScreen,
        params: {
          onPress: () => replaceScreen(ScreenNames.JoinCommunityScreen),
          icon: appImages.quiet_icon_round,
          title: 'Invalid invitation link',
          message: 'Please check your invitation link and try again',
        },
      })
    )
    return
  }

  console.log('INIT_NAVIGATION: Switching to the join community screen.')

  yield* put(
    navigationActions.replaceScreen({
      screen: ScreenNames.JoinCommunityScreen,
      params: {
        code,
      },
    })
  )

  const payload: CreateNetworkPayload = {
    ownership: CommunityOwnership.User,
    peers: data.pairs,
    psk: data.psk,
    ownerOrbitDbIdentity: data.ownerOrbitDbIdentity,
  }

  yield* put(communities.actions.createNetwork(payload))

  // It's time for the user to see the pasted code
  yield* delay(2000)

  console.log('INIT_NAVIGATION: Switching to the username registration screen.')
  yield* put(
    navigationActions.replaceScreen({
      screen: ScreenNames.UsernameRegistrationScreen,
    })
  )
}
