import React from 'react'
import '@testing-library/jest-dom/extend-expect'
import { act } from 'react-dom/test-utils'
import { screen } from '@testing-library/dom'
import userEvent from '@testing-library/user-event'
import { take } from 'typed-redux-saga'
import { renderComponent } from '../renderer/testUtils/renderComponent'
import { prepareStore } from '../renderer/testUtils/prepareStore'
import { modalsActions } from '../renderer/sagas/modals/modals.slice'
import JoinCommunity from '../renderer/components/CreateJoinCommunity/JoinCommunity/JoinCommunity'
import CreateUsername from '../renderer/components/CreateUsername/CreateUsername'
import { ModalName } from '../renderer/sagas/modals/modals.types'
import { JoinCommunityDictionary } from '../renderer/components/CreateJoinCommunity/community.dictionary'
import MockedSocket from 'socket.io-mock'
import { ioMock } from '../shared/setupTests'
import { socketEventData } from '../renderer/testUtils/socket'
import {
  identity,
  communities,
  SocketActionTypes,
  RegisterUserCertificatePayload,
  InitCommunityPayload,
  ErrorCodes,
  ErrorMessages,
  getFactory,
  errors,
  ResponseCreateNetworkPayload,
} from '@quiet/state-manager'
import Channel from '../renderer/components/Channel/Channel'
import LoadingPanel from '../renderer/components/LoadingPanel/LoadingPanel'
import { createUserCertificateTestHelper } from '@quiet/identity'
import { AnyAction } from 'redux'
import {
  InvitationData,
  ChannelsReplicatedPayload,
  Community,
  ErrorPayload,
  ResponseLaunchCommunityPayload,
  SendOwnerCertificatePayload,
} from '@quiet/types'
import { composeInvitationShareUrl } from '@quiet/common'

jest.setTimeout(20_000)

describe('User', () => {
  let socket: MockedSocket
  const validData: InvitationData = {
    pairs: [
      {
        onionAddress: 'y7yczmugl2tekami7sbdz5pfaemvx7bahwthrdvcbzw5vex2crsr26qd',
        peerId: 'QmZoiJNAvCffeEHBjk766nLuKVdkxkAT7wfFJDPPLsbKSE',
      },
    ],
    psk: 'BNlxfE2WBF7LrlpIX0CvECN5o1oZtA16PkAb7GYiwYw=',
    ownerOrbitDbIdentity: 'testOrbitDbIdentity',
  }
  const validCode = composeInvitationShareUrl(validData)
  // trigger
  beforeEach(() => {
    socket = new MockedSocket()
    ioMock.mockImplementation(() => socket)
    window.ResizeObserver = jest.fn().mockImplementation(() => ({
      observe: jest.fn(),
      unobserve: jest.fn(),
      disconnect: jest.fn(),
    }))
  })

  it('joins community and registers username', async () => {
    const { store, runSaga } = await prepareStore(
      {},
      socket // Fork state manager's sagas
    )

    store.dispatch(modalsActions.openModal({ name: ModalName.joinCommunityModal }))
    window.HTMLElement.prototype.scrollTo = jest.fn()

    renderComponent(
      <>
        <LoadingPanel />
        <JoinCommunity />
        <CreateUsername />
        <Channel />
      </>,
      store
    )

    const factory = await getFactory(store)

    jest.spyOn(socket, 'emit').mockImplementation(async (...input: [SocketActionTypes, ...socketEventData<[any]>]) => {
      const action = input[0]
      if (action === SocketActionTypes.CREATE_NETWORK) {
        const payload = input[1] as Community
        return socket.socketClient.emit<ResponseCreateNetworkPayload>(SocketActionTypes.NETWORK, {
          community: payload,
          network: {
            hiddenService: {
              onionAddress: 'onionAddress',
              privateKey: 'privKey',
            },
            peerId: {
              id: 'peerId',
            },
          },
        })
      }
      if (action === SocketActionTypes.LAUNCH_COMMUNITY) {
        const payload = input[1] as InitCommunityPayload
        const community = communities.selectors.currentCommunity(store.getState())
        expect(payload.id).toEqual(community?.id)
        socket.socketClient.emit<ResponseLaunchCommunityPayload>(SocketActionTypes.COMMUNITY, {
          id: payload.id,
        })
        socket.socketClient.emit<ChannelsReplicatedPayload>(SocketActionTypes.CHANNELS_REPLICATED, {
          channels: {
            general: {
              name: 'general',
              description: 'string',
              owner: 'owner',
              timestamp: 0,
              id: 'general',
            },
          },
        })
      }
    })

    // Log all the dispatched actions in order
    const actions: AnyAction[] = []
    runSaga(function* (): Generator {
      while (true) {
        const action: AnyAction = yield* take()
        actions.push(action.type)
      }
    })

    // Confirm proper modal title is displayed
    const dictionary = JoinCommunityDictionary()
    const joinCommunityTitle = screen.getByText(dictionary.header)
    expect(joinCommunityTitle).toBeVisible()

    // Enter community address and hit button
    const joinCommunityInput = screen.getByPlaceholderText(dictionary.placeholder)
    const joinCommunityButton = screen.getByText(dictionary.button)
    await userEvent.type(joinCommunityInput, validCode)
    await userEvent.click(joinCommunityButton)

    // Confirm user is being redirected to username registration
    const createUsernameTitle = await screen.findByText('Register a username')
    expect(createUsernameTitle).toBeVisible()

    // Enter username and hit button
    const createUsernameInput = screen.getByPlaceholderText('Enter a username')
    const createUsernameButton = screen.getByText('Register')
    await userEvent.type(createUsernameInput, 'alice')
    await userEvent.click(createUsernameButton)

    // Wait for the actions that updates the store
    await act(async () => {})

    // Check if join/username modals are gone
    expect(joinCommunityTitle).not.toBeVisible()
    expect(createUsernameTitle).not.toBeVisible()

    // Check if channel page is visible
    const channelPage = await screen.findByText('#general')
    expect(channelPage).toBeVisible()

    expect(actions).toMatchInlineSnapshot(`
      Array [
        "Communities/createNetwork",
        "Communities/setInvitationCodes",
        "Communities/savePSK",
        "Communities/addNewCommunity",
        "Communities/setCurrentCommunity",
        "Modals/closeModal",
        "Modals/openModal",
        "Identity/registerUsername",
        "Communities/responseCreateNetwork",
        "Communities/updateCommunityData",
        "Identity/addNewIdentity",
        "Network/setLoadingPanelType",
        "Modals/openModal",
        "Identity/registerCertificate",
        "Communities/launchCommunity",
        "Communities/sendCommunityCaData",
        "Files/checkForMissingFiles",
        "Network/addInitializedCommunity",
        "Communities/clearInvitationCodes",
        "Communities/sendCommunityMetadata",
        "PublicChannels/channelsReplicated",
        "PublicChannels/addChannel",
        "Messages/addPublicChannelsMessagesBase",
        "Modals/closeModal",
        "Messages/lazyLoading",
        "Messages/resetCurrentPublicChannelCache",
        "Messages/resetCurrentPublicChannelCache",
      ]
    `)
  })

  // We don't display registration errors right now
  it.skip('sees proper registration error when trying to join with already taken username', async () => {
    const { store, runSaga } = await prepareStore(
      {},
      socket // Fork state manager's sagas
    )

    store.dispatch(modalsActions.openModal({ name: ModalName.joinCommunityModal }))

    renderComponent(
      <>
        <LoadingPanel />
        <JoinCommunity />
        <CreateUsername />
        <Channel />
      </>,
      store
    )

    jest.spyOn(socket, 'emit').mockImplementation(async (...input: [SocketActionTypes, ...socketEventData<[any]>]) => {
      const action = input[0]
      if (action === SocketActionTypes.CREATE_NETWORK) {
        const payload = input[1] as Community
        return socket.socketClient.emit<ResponseCreateNetworkPayload>(SocketActionTypes.NETWORK, {
          community: payload,
          network: {
            hiddenService: {
              onionAddress: 'onionAddress',
              privateKey: 'privKey',
            },
            peerId: {
              id: 'peerId',
            },
          },
        })
      }
      if (action === SocketActionTypes.REGISTER_USER_CERTIFICATE) {
        const payload = input[1] as RegisterUserCertificatePayload
        const community = communities.selectors.currentCommunity(store.getState())
        expect(payload.communityId).toEqual(community?.id)
        socket.socketClient.emit<ErrorPayload>(SocketActionTypes.ERROR, {
          type: SocketActionTypes.REGISTER_USER_CERTIFICATE,
          code: ErrorCodes.FORBIDDEN,
          message: ErrorMessages.USERNAME_TAKEN,
          community: community?.id,
        })
      }
    })

    // Log all the dispatched actions in order
    const actions: AnyAction[] = []
    runSaga(function* (): Generator {
      while (true) {
        const action = yield* take()
        actions.push(action.type)
      }
    })

    // Confirm proper modal title is displayed
    const dictionary = JoinCommunityDictionary()
    const joinCommunityTitle = screen.getByText(dictionary.header)
    expect(joinCommunityTitle).toBeVisible()

    // Enter community address and hit button
    const joinCommunityInput = screen.getByPlaceholderText(dictionary.placeholder)
    const joinCommunityButton = screen.getByText(dictionary.button)
    await userEvent.type(joinCommunityInput, validCode)
    await userEvent.click(joinCommunityButton)

    // Confirm user is being redirected to username registration
    const createUsernameTitle = await screen.findByText('Register a username')
    expect(createUsernameTitle).toBeVisible()

    // Enter username and hit button
    const createUsernameInput = screen.getByPlaceholderText('Enter a username')
    const createUsernameButton = screen.getByText('Register')
    await userEvent.type(createUsernameInput, 'bob')
    await userEvent.click(createUsernameButton)

    // Wait for the actions that updates the store
    await act(async () => {})

    // Check if 'username taken' error message is visible
    expect(createUsernameTitle).toBeVisible()
    const usernameTakenErrorMessage = await screen.findByText(ErrorMessages.USERNAME_TAKEN)
    expect(usernameTakenErrorMessage).toBeVisible()

    expect(actions).toMatchInlineSnapshot()
  })

  it.skip('clears error before sending another username registration request', async () => {
    const { store, runSaga } = await prepareStore(
      {},
      socket // Fork state manager's sagas
    )
    store.dispatch(modalsActions.openModal({ name: ModalName.joinCommunityModal }))

    renderComponent(
      <>
        <LoadingPanel />
        <JoinCommunity />
        <CreateUsername />
        <Channel />
      </>,
      store
    )

    jest.spyOn(socket, 'emit').mockImplementation(async (...input: [SocketActionTypes, ...socketEventData<[any]>]) => {
      const action = input[0]
      if (action === SocketActionTypes.CREATE_NETWORK) {
        const payload = input[1] as Community
        return socket.socketClient.emit<ResponseCreateNetworkPayload>(SocketActionTypes.NETWORK, {
          community: payload,
          network: {
            hiddenService: {
              onionAddress: 'onionAddress',
              privateKey: 'privKey',
            },
            peerId: {
              id: 'peerId',
            },
          },
        })
      }
    })

    // Log all the dispatched actions in order
    const actions: AnyAction[] = []
    runSaga(function* (): Generator {
      while (true) {
        const action = yield* take()
        actions.push(action.type)
      }
    })

    // Confirm proper modal title is displayed
    const dictionary = JoinCommunityDictionary()
    const joinCommunityTitle = screen.getByText(dictionary.header)
    expect(joinCommunityTitle).toBeVisible()

    // Enter community address and hit button
    const joinCommunityInput = screen.getByPlaceholderText(dictionary.placeholder)
    const joinCommunityButton = screen.getByText(dictionary.button)
    await userEvent.type(joinCommunityInput, validCode)
    await userEvent.click(joinCommunityButton)

    // Confirm user is being redirected to username registration
    const createUsernameTitle = await screen.findByText('Register a username')
    expect(createUsernameTitle).toBeVisible()

    await act(async () => {
      const community = communities.selectors.currentCommunity(store.getState())
      store.dispatch(
        errors.actions.addError({
          type: SocketActionTypes.REGISTER_USER_CERTIFICATE,
          code: ErrorCodes.FORBIDDEN,
          message: ErrorMessages.USERNAME_TAKEN,
          community: community?.id,
        })
      )
    })

    // Check if 'username taken' error message is visible
    expect(createUsernameTitle).toBeVisible()
    expect(await screen.findByText(ErrorMessages.USERNAME_TAKEN)).toBeVisible()

    // Enter username and hit button
    const createUsernameInput = screen.getByPlaceholderText('Enter a username')
    const createUsernameButton = screen.getByText('Register')
    await userEvent.type(createUsernameInput, 'bob')
    await userEvent.click(createUsernameButton)

    // Wait for the actions that updates the store
    await act(async () => {})

    // Check if 'username taken' error message disappeared
    expect(await screen.queryByText(ErrorMessages.USERNAME_TAKEN)).toBeNull()

    expect(actions).toMatchInlineSnapshot()
  })
})
