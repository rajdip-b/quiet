import React from 'react';
import { storiesOf } from '@storybook/react-native';

import { Message } from './Message.component';
import { MessageType } from '@quiet/nectar';

storiesOf('Message', module).add('Default', () => {
  return (
    <Message
      message={{
        id: '1',
        type: MessageType.Basic,
        message:
          'Brownie powder marshmallow dessert carrot cake marzipan cake caramels. Muffin topping wafer jelly apple pie candy. Fruitcake chocolate pudding fruitcake candy lemon drops chocolate.',
        createdAt: 0,  
        date: '1:30pm',
        nickname: 'holmes',
      }}
    />
  );
});
