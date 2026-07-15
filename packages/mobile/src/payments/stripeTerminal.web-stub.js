/**
 * Web Metro stub for `@stripe/stripe-terminal-react-native`.
 * Native builds resolve the real package; web e2e must not touch NativeModules.
 */
function unavailable() {
  return Promise.resolve({
    error: { message: 'Stripe Terminal is not available on web' },
  });
}

const StripeTerminalProvider = ({ children }) => children;

function useStripeTerminal() {
  return {
    initialize: unavailable,
    easyConnect: unavailable,
    retrievePaymentIntent: unavailable,
    collectPaymentMethod: unavailable,
    confirmPaymentIntent: unavailable,
    connectedReader: null,
    loading: false,
  };
}

module.exports = {
  StripeTerminalProvider,
  useStripeTerminal,
  AppsOnDevicesConnectionTokenProvider: Symbol('AppsOnDevicesConnectionTokenProvider'),
};
