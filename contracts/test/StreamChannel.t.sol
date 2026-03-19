// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {StreamChannel} from "../src/StreamChannel.sol";
import {IStreamChannel} from "../src/interfaces/IStreamChannel.sol";

/// @dev Minimal ERC-20 mock for testing
contract MockERC20 is Test {
    string public name = "Mock USDC";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract StreamChannelTest is Test {
    StreamChannel public channel;
    MockERC20 public usdc;

    address payer;
    uint256 payerKey;
    address payee;
    uint256 payeeKey;

    bytes32 constant VOUCHER_TYPEHASH =
        keccak256("Voucher(bytes32 channelId,uint128 cumulativeAmount)");

    function setUp() public {
        channel = new StreamChannel();
        usdc = new MockERC20();

        (payer, payerKey) = makeAddrAndKey("payer");
        (payee, payeeKey) = makeAddrAndKey("payee");

        // Fund payer with 10,000 USDC
        usdc.mint(payer, 10_000e6);

        // Payer approves channel contract
        vm.prank(payer);
        usdc.approve(address(channel), type(uint256).max);
    }

    // ──────────────────────────────────────────────
    //  Helpers
    // ──────────────────────────────────────────────

    function _openChannel(uint128 deposit) internal returns (bytes32) {
        vm.prank(payer);
        return channel.open(payee, address(usdc), deposit, bytes32(0), address(0));
    }

    function _signVoucher(
        bytes32 channelId,
        uint128 cumulativeAmount,
        uint256 signerKey
    ) internal view returns (bytes memory) {
        bytes32 digest = channel.getVoucherDigest(channelId, cumulativeAmount);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    // ──────────────────────────────────────────────
    //  open()
    // ──────────────────────────────────────────────

    function test_open_basic() public {
        bytes32 channelId = _openChannel(1000e6);

        IStreamChannel.Channel memory ch = channel.getChannel(channelId);
        assertEq(ch.payer, payer);
        assertEq(ch.payee, payee);
        assertEq(ch.token, address(usdc));
        assertEq(ch.deposit, 1000e6);
        assertEq(ch.settled, 0);
        assertFalse(ch.finalized);
        assertEq(ch.closeRequestedAt, 0);

        // Funds moved to contract
        assertEq(usdc.balanceOf(address(channel)), 1000e6);
        assertEq(usdc.balanceOf(payer), 9000e6);
    }

    function test_open_withAuthorizedSigner() public {
        (address signer,) = makeAddrAndKey("signer");
        vm.prank(payer);
        bytes32 channelId = channel.open(payee, address(usdc), 500e6, bytes32(0), signer);

        IStreamChannel.Channel memory ch = channel.getChannel(channelId);
        assertEq(ch.authorizedSigner, signer);
    }

    function test_open_revert_zeroPayee() public {
        vm.prank(payer);
        vm.expectRevert(IStreamChannel.InvalidPayee.selector);
        channel.open(address(0), address(usdc), 1000e6, bytes32(0), address(0));
    }

    function test_open_revert_invalidToken() public {
        vm.prank(payer);
        vm.expectRevert(IStreamChannel.InvalidToken.selector);
        channel.open(payee, address(0xdead), 1000e6, bytes32(0), address(0)); // EOA, not contract
    }

    function test_open_revert_zeroDeposit() public {
        vm.prank(payer);
        vm.expectRevert(IStreamChannel.ZeroDeposit.selector);
        channel.open(payee, address(usdc), 0, bytes32(0), address(0));
    }

    function test_open_revert_duplicate() public {
        _openChannel(1000e6);
        vm.prank(payer);
        vm.expectRevert(IStreamChannel.ChannelAlreadyExists.selector);
        channel.open(payee, address(usdc), 500e6, bytes32(0), address(0));
    }

    // ──────────────────────────────────────────────
    //  settle()
    // ──────────────────────────────────────────────

    function test_settle_basic() public {
        bytes32 channelId = _openChannel(1000e6);
        bytes memory sig = _signVoucher(channelId, 200e6, payerKey);

        vm.prank(payee);
        channel.settle(channelId, 200e6, sig);

        IStreamChannel.Channel memory ch = channel.getChannel(channelId);
        assertEq(ch.settled, 200e6);
        assertEq(usdc.balanceOf(payee), 200e6);
        assertEq(usdc.balanceOf(address(channel)), 800e6);
    }

    function test_settle_incremental() public {
        bytes32 channelId = _openChannel(1000e6);

        // First settle: 100
        bytes memory sig1 = _signVoucher(channelId, 100e6, payerKey);
        vm.prank(payee);
        channel.settle(channelId, 100e6, sig1);

        // Second settle: cumulative 400 (delta = 300)
        bytes memory sig2 = _signVoucher(channelId, 400e6, payerKey);
        vm.prank(payee);
        channel.settle(channelId, 400e6, sig2);

        assertEq(usdc.balanceOf(payee), 400e6);
        assertEq(channel.getChannel(channelId).settled, 400e6);
    }

    function test_settle_withAuthorizedSigner() public {
        (address signer, uint256 signerKey) = makeAddrAndKey("delegatedSigner");

        vm.prank(payer);
        bytes32 channelId = channel.open(payee, address(usdc), 1000e6, bytes32(0), signer);

        bytes memory sig = _signVoucher(channelId, 300e6, signerKey);
        vm.prank(payee);
        channel.settle(channelId, 300e6, sig);

        assertEq(usdc.balanceOf(payee), 300e6);
    }

    function test_settle_revert_notPayee() public {
        bytes32 channelId = _openChannel(1000e6);
        bytes memory sig = _signVoucher(channelId, 100e6, payerKey);

        vm.prank(payer); // wrong caller
        vm.expectRevert(IStreamChannel.NotPayee.selector);
        channel.settle(channelId, 100e6, sig);
    }

    function test_settle_revert_exceedsDeposit() public {
        bytes32 channelId = _openChannel(1000e6);
        bytes memory sig = _signVoucher(channelId, 2000e6, payerKey);

        vm.prank(payee);
        vm.expectRevert(IStreamChannel.AmountExceedsDeposit.selector);
        channel.settle(channelId, 2000e6, sig);
    }

    function test_settle_revert_notIncreasing() public {
        bytes32 channelId = _openChannel(1000e6);

        bytes memory sig1 = _signVoucher(channelId, 500e6, payerKey);
        vm.prank(payee);
        channel.settle(channelId, 500e6, sig1);

        // Try settling same or lower amount
        bytes memory sig2 = _signVoucher(channelId, 500e6, payerKey);
        vm.prank(payee);
        vm.expectRevert(IStreamChannel.AmountNotIncreasing.selector);
        channel.settle(channelId, 500e6, sig2);
    }

    function test_settle_revert_invalidSignature() public {
        bytes32 channelId = _openChannel(1000e6);
        bytes memory sig = _signVoucher(channelId, 200e6, payeeKey); // signed by wrong key

        vm.prank(payee);
        vm.expectRevert(IStreamChannel.InvalidSignature.selector);
        channel.settle(channelId, 200e6, sig);
    }

    // ──────────────────────────────────────────────
    //  topUp()
    // ──────────────────────────────────────────────

    function test_topUp() public {
        bytes32 channelId = _openChannel(1000e6);

        vm.prank(payer);
        channel.topUp(channelId, 500e6);

        assertEq(channel.getChannel(channelId).deposit, 1500e6);
        assertEq(usdc.balanceOf(address(channel)), 1500e6);
    }

    function test_topUp_cancelsCloseRequest() public {
        bytes32 channelId = _openChannel(1000e6);

        vm.prank(payer);
        channel.requestClose(channelId);
        assertTrue(channel.getChannel(channelId).closeRequestedAt != 0);

        vm.prank(payer);
        channel.topUp(channelId, 100e6);
        assertEq(channel.getChannel(channelId).closeRequestedAt, 0);
    }

    // ──────────────────────────────────────────────
    //  requestClose() + withdraw()
    // ──────────────────────────────────────────────

    function test_requestClose_and_withdraw() public {
        bytes32 channelId = _openChannel(1000e6);

        // Settle 300 first
        bytes memory sig = _signVoucher(channelId, 300e6, payerKey);
        vm.prank(payee);
        channel.settle(channelId, 300e6, sig);

        // Request close
        vm.prank(payer);
        channel.requestClose(channelId);

        // Can't withdraw yet
        vm.prank(payer);
        vm.expectRevert(IStreamChannel.CloseNotReady.selector);
        channel.withdraw(channelId);

        // Warp past grace period
        vm.warp(block.timestamp + 15 minutes + 1);

        vm.prank(payer);
        channel.withdraw(channelId);

        // Payer gets refund of 700
        assertEq(usdc.balanceOf(payer), 9700e6); // started 10k, deposited 1k, got 700 back
        assertTrue(channel.getChannel(channelId).finalized);
    }

    // ──────────────────────────────────────────────
    //  close() (cooperative, by payee)
    // ──────────────────────────────────────────────

    function test_close_cooperative() public {
        bytes32 channelId = _openChannel(1000e6);

        // Settle 200 first
        bytes memory sig1 = _signVoucher(channelId, 200e6, payerKey);
        vm.prank(payee);
        channel.settle(channelId, 200e6, sig1);

        // Close with final voucher of 600 (delta = 400)
        bytes memory sig2 = _signVoucher(channelId, 600e6, payerKey);
        vm.prank(payee);
        channel.close(channelId, 600e6, sig2);

        assertEq(usdc.balanceOf(payee), 600e6);
        assertEq(usdc.balanceOf(payer), 9400e6); // 10k - 1k + 400 refund
        assertTrue(channel.getChannel(channelId).finalized);
    }

    function test_close_noNewVoucher() public {
        bytes32 channelId = _openChannel(1000e6);

        // Settle 500
        bytes memory sig = _signVoucher(channelId, 500e6, payerKey);
        vm.prank(payee);
        channel.settle(channelId, 500e6, sig);

        // Close with same amount (no new voucher needed)
        vm.prank(payee);
        channel.close(channelId, 500e6, "");

        assertEq(usdc.balanceOf(payee), 500e6);
        assertEq(usdc.balanceOf(payer), 9500e6);
        assertTrue(channel.getChannel(channelId).finalized);
    }

    // ──────────────────────────────────────────────
    //  View helpers
    // ──────────────────────────────────────────────

    function test_computeChannelId_isChainAware() public view {
        bytes32 id = channel.computeChannelId(payer, payee, address(usdc), bytes32(0), address(0));
        assertTrue(id != bytes32(0));
    }

    function test_getChannelsBatch() public {
        bytes32 id1 = _openChannel(100e6);

        // Open second channel with different salt
        vm.prank(payer);
        bytes32 id2 = channel.open(payee, address(usdc), 200e6, bytes32(uint256(1)), address(0));

        bytes32[] memory ids = new bytes32[](2);
        ids[0] = id1;
        ids[1] = id2;

        IStreamChannel.Channel[] memory chs = channel.getChannelsBatch(ids);
        assertEq(chs.length, 2);
        assertEq(chs[0].deposit, 100e6);
        assertEq(chs[1].deposit, 200e6);
    }

    function test_domainSeparator() public view {
        bytes32 ds = channel.domainSeparator();
        assertTrue(ds != bytes32(0));
    }

    // ──────────────────────────────────────────────
    //  Finalized channel reverts
    // ──────────────────────────────────────────────

    function test_revert_operationsOnFinalizedChannel() public {
        bytes32 channelId = _openChannel(1000e6);

        // Close it
        vm.prank(payee);
        channel.close(channelId, 0, "");

        // All ops should revert
        vm.prank(payer);
        vm.expectRevert(IStreamChannel.ChannelFinalized.selector);
        channel.topUp(channelId, 100e6);

        vm.prank(payee);
        vm.expectRevert(IStreamChannel.ChannelFinalized.selector);
        channel.settle(channelId, 100e6, "");

        vm.prank(payer);
        vm.expectRevert(IStreamChannel.ChannelFinalized.selector);
        channel.requestClose(channelId);
    }
}
