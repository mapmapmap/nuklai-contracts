import {
  AcceptManuallyVerifier,
  DatasetFactory,
  DatasetNFT,
  DistributionManager,
  ERC20LinearSingleDatasetSubscriptionManager,
  FragmentNFT,
  VerifierManager,
} from "@typechained";
import { MaxUint256, ZeroHash, parseUnits } from "ethers";
import { deployments, ethers, network } from "hardhat";
import { expect } from "chai";
import { v4 as uuidv4 } from "uuid";
import { constants, signature, utils } from "./utils";
import { getTestTokenContract } from "./utils/contracts";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const setup = async () => {
  await deployments.fixture(["DatasetFactory", "DatasetVerifiers"]);

  const contracts = {
    DatasetFactory: (await ethers.getContract(
      "DatasetFactory"
    )) as DatasetFactory,
    DatasetNFT: (await ethers.getContract("DatasetNFT")) as DatasetNFT,
    FragmentNFTImplementation: (await ethers.getContract(
      "FragmentNFT"
    )) as FragmentNFT,
  };

  const { dtAdmin, datasetOwner } = await ethers.getNamedSigners();
  const datasetId = 1;
  const fragmentId = 1;

  const datasetUUID = uuidv4();

  await contracts.DatasetNFT.connect(dtAdmin).setUuidForDatasetId(datasetUUID);

  const datasetAddress = await contracts.DatasetNFT.getAddress();
  const signedMessage = await dtAdmin.signMessage(
    signature.getDatasetMintMessage(
      network.config.chainId!,
      datasetAddress,
      datasetId
    )
  );
  const defaultVerifierAddress = await (
    await ethers.getContract("AcceptManuallyVerifier")
  ).getAddress();
  const Token = await getTestTokenContract(dtAdmin, {
    mint: parseUnits("100000000", 18),
  });
  const feeAmount = parseUnits("0.1", 18);
  const dsOwnerPercentage = parseUnits("0.001", 18);

  await contracts.DatasetFactory.connect(datasetOwner).mintAndConfigureDataset(
    datasetOwner.address,
    signedMessage,
    defaultVerifierAddress,
    await Token.getAddress(),
    feeAmount,
    dsOwnerPercentage,
    [ZeroHash],
    [parseUnits("1", 18)]
  );

  const datasetSchemasTag = utils.encodeTag("dataset.schemas");

  const fragmentAddress = await contracts.DatasetNFT.fragments(datasetId);
  const DatasetFragment = (await ethers.getContractAt(
    "FragmentNFT",
    fragmentAddress
  )) as unknown as FragmentNFT;
  const lastFragmentPendingId = await DatasetFragment.lastFragmentPendingId();

  const proposeSignatureSchemas = await dtAdmin.signMessage(
    signature.getDatasetFragmentProposeMessage(
      network.config.chainId!,
      await contracts.DatasetNFT.getAddress(),
      datasetId,
      lastFragmentPendingId + 1n,
      datasetOwner.address,
      datasetSchemasTag
    )
  );

  await contracts.DatasetNFT.connect(datasetOwner).proposeFragment(
    datasetId,
    datasetOwner.address,
    datasetSchemasTag,
    proposeSignatureSchemas
  );

  const DatasetVerifierManager = (await ethers.getContractAt(
    "VerifierManager",
    await contracts.DatasetNFT.verifierManager(datasetId),
    datasetOwner
  )) as unknown as VerifierManager;

  const AcceptManuallyVerifier = (await ethers.getContract(
    "AcceptManuallyVerifier"
  )) as unknown as AcceptManuallyVerifier;

  await AcceptManuallyVerifier.connect(datasetOwner).resolve(
    fragmentAddress,
    lastFragmentPendingId + 1n,
    true
  );

  return {
    datasetId,
    fragmentId,
    DatasetSubscriptionManager: (await ethers.getContractAt(
      "ERC20LinearSingleDatasetSubscriptionManager",
      await contracts.DatasetNFT.subscriptionManager(datasetId)
    )) as unknown as ERC20LinearSingleDatasetSubscriptionManager,
    DatasetDistributionManager: (await ethers.getContractAt(
      "DistributionManager",
      await contracts.DatasetNFT.distributionManager(datasetId),
      datasetOwner
    )) as unknown as DistributionManager,
    DatasetVerifierManager,
    ...contracts,
  };
};

describe("DistributionManager", () => {
  it("Should data set owner set its percentage to be sent on each payment", async function () {
    const { DatasetDistributionManager } = await setup();
    const { datasetOwner } = await ethers.getNamedSigners();

    const percentage = parseUnits("0.01", 18);

    await DatasetDistributionManager.connect(
      datasetOwner
    ).setDatasetOwnerPercentage(percentage);

    expect(await DatasetDistributionManager.datasetOwnerPercentage()).to.equal(
      percentage
    );
  });

  it("Should revert if data set owner percentage set is higher than 100%", async function () {
    const { DatasetDistributionManager } = await setup();
    const { datasetOwner } = await ethers.getNamedSigners();

    const percentage = parseUnits("1.01", 18);

    await expect(
      DatasetDistributionManager.connect(
        datasetOwner
      ).setDatasetOwnerPercentage(percentage)
    ).to.be.revertedWith("Can't be higher than 100%");
  });

  it("Should revert set percentage if sender is not the data set owner", async function () {
    const { DatasetDistributionManager } = await setup();
    const { user } = await ethers.getNamedSigners();

    const percentage = parseUnits("1.01", 18);

    await expect(
      (DatasetDistributionManager as unknown as DistributionManager)
        .connect(user)
        .setDatasetOwnerPercentage(percentage)
    ).to.be.revertedWith("Not a Dataset owner");
  });

  it("Should data set owner set data set tag weights", async function () {
    const { DatasetDistributionManager } = await setup();
    const { datasetOwner } = await ethers.getNamedSigners();

    const datasetSchemasTag = utils.encodeTag("dataset.schemas");
    const datasetRowsTag = utils.encodeTag("dataset.rows");

    await DatasetDistributionManager.connect(datasetOwner).setTagWeights(
      [datasetSchemasTag, datasetRowsTag],
      [parseUnits("0.4", 18), parseUnits("0.6", 18)]
    );
  });

  it("Should revert set tag weights if weights sum is not equal to 100%", async function () {
    const { DatasetDistributionManager } = await setup();
    const { datasetOwner } = await ethers.getNamedSigners();

    const datasetSchemasTag = utils.encodeTag("dataset.schemas");
    const datasetRowsTag = utils.encodeTag("dataset.rows");

    await expect(
      DatasetDistributionManager.connect(datasetOwner).setTagWeights(
        [datasetSchemasTag, datasetRowsTag],
        [parseUnits("0.4", 18), parseUnits("0.8", 18)]
      )
    ).to.be.revertedWith("Invalid weights summ");
  });

  it("Should data set owner claim revenue", async function () {
    const {
      DatasetDistributionManager,
      DatasetSubscriptionManager,
      DatasetNFT,
      datasetId,
    } = await setup();
    const { datasetOwner, dtAdmin, contributor, subscriber } =
      await ethers.getNamedSigners();

    const datasetSchemasTag = utils.encodeTag("dataset.schemas");
    const datasetRowsTag = utils.encodeTag("dataset.rows");

    const fragmentAddress = await DatasetNFT.fragments(datasetId);
    const DatasetFragment = (await ethers.getContractAt(
      "FragmentNFT",
      fragmentAddress
    )) as unknown as FragmentNFT;

    const nextPendingFragmentId =
      (await DatasetFragment.lastFragmentPendingId()) + 1n;

    const proposeSignatureSchemas = await dtAdmin.signMessage(
      signature.getDatasetFragmentProposeMessage(
        network.config.chainId!,
        await DatasetNFT.getAddress(),
        datasetId,
        nextPendingFragmentId,
        contributor.address,
        datasetSchemasTag
      )
    );

    await DatasetNFT.connect(contributor).proposeFragment(
      datasetId,
      contributor.address,
      datasetSchemasTag,
      proposeSignatureSchemas
    );

    const datasetFragmentAddress = await DatasetNFT.fragments(datasetId);

    const AcceptManuallyVerifier = (await ethers.getContract(
      "AcceptManuallyVerifier"
    )) as unknown as AcceptManuallyVerifier;

    await AcceptManuallyVerifier.connect(datasetOwner).resolve(
      datasetFragmentAddress,
      nextPendingFragmentId,
      true
    );

    await DatasetDistributionManager.connect(
      datasetOwner
    ).setDatasetOwnerPercentage(ethers.parseUnits("0.001", 18));

    const Token = await getTestTokenContract(subscriber, {
      mint: parseUnits("100000000", 18),
    });

    const tokenAddress = await Token.getAddress();

    await Token.connect(subscriber).approve(
      await DatasetSubscriptionManager.getAddress(),
      MaxUint256
    );

    await DatasetDistributionManager.connect(datasetOwner).setTagWeights(
      [datasetSchemasTag, datasetRowsTag],
      [parseUnits("0.4", 18), parseUnits("0.6", 18)]
    );

    const feeAmount = parseUnits("0.1", 18);

    await DatasetSubscriptionManager.connect(datasetOwner).setFee(
      tokenAddress,
      feeAmount
    );

    const subscriptionStart =
      Number((await ethers.provider.getBlock("latest"))?.timestamp) + 1;

    await DatasetSubscriptionManager.connect(subscriber).subscribe(
      datasetId,
      subscriptionStart,
      constants.ONE_WEEK,
      1
    );

    const claimableAmount = await DatasetDistributionManager.pendingOwnerFee(
      tokenAddress
    );

    const claimDatasetOwnerSignature = await dtAdmin.signMessage(
      signature.getDatasetOwnerClaimMessage(
        network.config.chainId!,
        await DatasetDistributionManager.getAddress(),
        tokenAddress,
        claimableAmount,
        datasetOwner.address
      )
    );

    await expect(
      DatasetDistributionManager.connect(datasetOwner).claimDatasetOwnerPayouts(
        tokenAddress,
        claimableAmount,
        datasetOwner.address,
        claimDatasetOwnerSignature
      )
    )
      .to.emit(DatasetDistributionManager, "PayoutSent")
      .withArgs(datasetOwner.address, tokenAddress, parseUnits("60.48", 18));
  });

  it("Should revert claim revenue if it's not the data set owner", async function () {
    const {
      DatasetDistributionManager,
      DatasetSubscriptionManager,
      DatasetVerifierManager,
      DatasetNFT,
      datasetId,
    } = await setup();
    const { datasetOwner, dtAdmin, contributor, subscriber } =
      await ethers.getNamedSigners();

    const datasetSchemasTag = utils.encodeTag("dataset.schemas");
    const datasetRowsTag = utils.encodeTag("dataset.rows");

    const fragmentAddress = await DatasetNFT.fragments(datasetId);
    const DatasetFragment = (await ethers.getContractAt(
      "FragmentNFT",
      fragmentAddress
    )) as unknown as FragmentNFT;

    const nextPendingFragmentId =
      (await DatasetFragment.lastFragmentPendingId()) + 1n;

    const proposeSignatureSchemas = await dtAdmin.signMessage(
      signature.getDatasetFragmentProposeMessage(
        network.config.chainId!,
        await DatasetNFT.getAddress(),
        datasetId,
        nextPendingFragmentId,
        contributor.address,
        datasetSchemasTag
      )
    );

    await DatasetNFT.connect(contributor).proposeFragment(
      datasetId,
      contributor.address,
      datasetSchemasTag,
      proposeSignatureSchemas
    );

    const datasetFragmentAddress = await DatasetNFT.fragments(datasetId);

    const AcceptManuallyVerifier = (await ethers.getContract(
      "AcceptManuallyVerifier"
    )) as unknown as AcceptManuallyVerifier;

    await AcceptManuallyVerifier.connect(datasetOwner).resolve(
      datasetFragmentAddress,
      nextPendingFragmentId,
      true
    );

    await DatasetDistributionManager.connect(
      datasetOwner
    ).setDatasetOwnerPercentage(ethers.parseUnits("0.001", 18));

    const Token = await getTestTokenContract(subscriber, {
      mint: parseUnits("100000000", 18),
    });

    const tokenAddress = await Token.getAddress();

    await Token.connect(subscriber).approve(
      await DatasetSubscriptionManager.getAddress(),
      MaxUint256
    );

    await DatasetDistributionManager.connect(datasetOwner).setTagWeights(
      [datasetSchemasTag, datasetRowsTag],
      [parseUnits("0.4", 18), parseUnits("0.6", 18)]
    );

    const feeAmount = parseUnits("0.1", 18);

    await DatasetSubscriptionManager.connect(datasetOwner).setFee(
      tokenAddress,
      feeAmount
    );

    const subscriptionStart =
      Number((await ethers.provider.getBlock("latest"))?.timestamp) + 1;

    await DatasetSubscriptionManager.connect(subscriber).subscribe(
      datasetId,
      subscriptionStart,
      constants.ONE_WEEK,
      1
    );

    const claimableAmount = await DatasetDistributionManager.pendingOwnerFee(
      tokenAddress
    );

    const claimDatasetOwnerSignature = await dtAdmin.signMessage(
      signature.getDatasetOwnerClaimMessage(
        network.config.chainId!,
        await DatasetDistributionManager.getAddress(),
        tokenAddress,
        claimableAmount,
        contributor.address
      )
    );

    await expect(
      DatasetDistributionManager.connect(contributor).claimDatasetOwnerPayouts(
        tokenAddress,
        claimableAmount,
        contributor.address,
        claimDatasetOwnerSignature
      )
    ).to.be.revertedWith("Not a Dataset owner");
  });

  it("Should revert data set owner from claiming revenue if signature is wrong", async function () {
    const {
      DatasetDistributionManager,
      DatasetSubscriptionManager,
      DatasetVerifierManager,
      DatasetNFT,
      datasetId,
    } = await setup();
    const { datasetOwner, dtAdmin, contributor, subscriber } =
      await ethers.getNamedSigners();

    const datasetSchemasTag = utils.encodeTag("dataset.schemas");
    const datasetRowsTag = utils.encodeTag("dataset.rows");

    const fragmentAddress = await DatasetNFT.fragments(datasetId);
    const DatasetFragment = (await ethers.getContractAt(
      "FragmentNFT",
      fragmentAddress
    )) as unknown as FragmentNFT;

    const nextPendingFragmentId =
      (await DatasetFragment.lastFragmentPendingId()) + 1n;

    const proposeSignatureSchemas = await dtAdmin.signMessage(
      signature.getDatasetFragmentProposeMessage(
        network.config.chainId!,
        await DatasetNFT.getAddress(),
        datasetId,
        nextPendingFragmentId,
        contributor.address,
        datasetSchemasTag
      )
    );

    await DatasetNFT.connect(contributor).proposeFragment(
      datasetId,
      contributor.address,
      datasetSchemasTag,
      proposeSignatureSchemas
    );

    const datasetFragmentAddress = await DatasetNFT.fragments(datasetId);

    const AcceptManuallyVerifier = (await ethers.getContract(
      "AcceptManuallyVerifier"
    )) as unknown as AcceptManuallyVerifier;

    await AcceptManuallyVerifier.connect(datasetOwner).resolve(
      datasetFragmentAddress,
      nextPendingFragmentId,
      true
    );

    await DatasetDistributionManager.connect(
      datasetOwner
    ).setDatasetOwnerPercentage(ethers.parseUnits("0.001", 18));

    const Token = await getTestTokenContract(subscriber, {
      mint: parseUnits("100000000", 18),
    });

    const tokenAddress = await Token.getAddress();

    await Token.connect(subscriber).approve(
      await DatasetSubscriptionManager.getAddress(),
      MaxUint256
    );

    await DatasetDistributionManager.connect(datasetOwner).setTagWeights(
      [datasetSchemasTag, datasetRowsTag],
      [parseUnits("0.4", 18), parseUnits("0.6", 18)]
    );

    const feeAmount = parseUnits("0.1", 18);

    await DatasetSubscriptionManager.connect(datasetOwner).setFee(
      tokenAddress,
      feeAmount
    );

    const subscriptionStart =
      Number((await ethers.provider.getBlock("latest"))?.timestamp) + 1;

    await DatasetSubscriptionManager.connect(subscriber).subscribe(
      datasetId,
      subscriptionStart,
      constants.ONE_WEEK,
      1
    );

    const claimableAmount = await DatasetDistributionManager.pendingOwnerFee(
      tokenAddress
    );

    const claimDatasetOwnerSignature = await dtAdmin.signMessage("0x");

    await expect(
      DatasetDistributionManager.connect(datasetOwner).claimDatasetOwnerPayouts(
        tokenAddress,
        claimableAmount,
        dtAdmin.address,
        claimDatasetOwnerSignature
      )
    ).to.be.revertedWithCustomError(
      DatasetDistributionManager,
      "BAD_SIGNATURE"
    );
  });

  it("Should contributor claim revenue after two weeks", async function () {
    const {
      DatasetDistributionManager,
      DatasetSubscriptionManager,
      DatasetVerifierManager,
      DatasetNFT,
      datasetId,
    } = await setup();
    const { datasetOwner, dtAdmin, contributor, subscriber } =
      await ethers.getNamedSigners();

    const datasetSchemasTag = utils.encodeTag("dataset.schemas");
    const datasetRowsTag = utils.encodeTag("dataset.rows");

    const fragmentAddress = await DatasetNFT.fragments(datasetId);
    const DatasetFragment = (await ethers.getContractAt(
      "FragmentNFT",
      fragmentAddress
    )) as unknown as FragmentNFT;

    const nextPendingFragmentId =
      (await DatasetFragment.lastFragmentPendingId()) + 1n;

    const proposeSignatureSchemas = await dtAdmin.signMessage(
      signature.getDatasetFragmentProposeMessage(
        network.config.chainId!,
        await DatasetNFT.getAddress(),
        datasetId,
        nextPendingFragmentId,
        contributor.address,
        datasetSchemasTag
      )
    );

    await DatasetNFT.connect(contributor).proposeFragment(
      datasetId,
      contributor.address,
      datasetSchemasTag,
      proposeSignatureSchemas
    );

    const datasetFragmentAddress = await DatasetNFT.fragments(datasetId);

    const AcceptManuallyVerifier = (await ethers.getContract(
      "AcceptManuallyVerifier"
    )) as unknown as AcceptManuallyVerifier;

    await AcceptManuallyVerifier.connect(datasetOwner).resolve(
      datasetFragmentAddress,
      nextPendingFragmentId,
      true
    );

    await DatasetDistributionManager.connect(
      datasetOwner
    ).setDatasetOwnerPercentage(ethers.parseUnits("0.001", 18));

    const Token = await getTestTokenContract(subscriber, {
      mint: parseUnits("100000000", 18),
    });

    const tokenAddress = await Token.getAddress();

    await Token.connect(subscriber).approve(
      await DatasetSubscriptionManager.getAddress(),
      MaxUint256
    );

    await DatasetDistributionManager.connect(datasetOwner).setTagWeights(
      [datasetSchemasTag, datasetRowsTag],
      [parseUnits("0.4", 18), parseUnits("0.6", 18)]
    );

    const feeAmount = parseUnits("0.1", 18);

    await DatasetSubscriptionManager.connect(datasetOwner).setFee(
      tokenAddress,
      feeAmount
    );

    const subscriptionStart =
      Number((await ethers.provider.getBlock("latest"))?.timestamp) + 1;

    await DatasetSubscriptionManager.connect(subscriber).subscribe(
      datasetId,
      subscriptionStart,
      constants.ONE_WEEK,
      1
    );

    const validSince =
      Number((await ethers.provider.getBlock("latest"))?.timestamp) +
      1 +
      constants.ONE_WEEK * 2;
    const validTill = validSince + constants.ONE_DAY;
    const fragmentOwnerSignature = await dtAdmin.signMessage(
      signature.getFragmentOwnerClaimMessage(
        network.config.chainId!,
        await DatasetDistributionManager.getAddress(),
        contributor.address,
        BigInt(validSince),
        BigInt(validTill)
      )
    );

    await time.increase(constants.ONE_WEEK * 2);

    await expect(
      DatasetDistributionManager.connect(contributor).claimPayouts(
        validSince,
        validTill,
        fragmentOwnerSignature
      )
    )
      .to.emit(DatasetDistributionManager, "PayoutSent")
      .withArgs(contributor.address, tokenAddress, parseUnits("12083.904", 18));
  });

  it("Should revert if contributor claims revenue before two weeks", async function () {
    const {
      DatasetDistributionManager,
      DatasetSubscriptionManager,
      DatasetVerifierManager,
      DatasetNFT,
      datasetId,
    } = await setup();
    const { datasetOwner, dtAdmin, contributor, subscriber } =
      await ethers.getNamedSigners();

    const datasetSchemasTag = utils.encodeTag("dataset.schemas");
    const datasetRowsTag = utils.encodeTag("dataset.rows");

    const fragmentAddress = await DatasetNFT.fragments(datasetId);
    const DatasetFragment = (await ethers.getContractAt(
      "FragmentNFT",
      fragmentAddress
    )) as unknown as FragmentNFT;

    const nextPendingFragmentId =
      (await DatasetFragment.lastFragmentPendingId()) + 1n;

    const proposeSignatureSchemas = await dtAdmin.signMessage(
      signature.getDatasetFragmentProposeMessage(
        network.config.chainId!,
        await DatasetNFT.getAddress(),
        datasetId,
        nextPendingFragmentId,
        contributor.address,
        datasetSchemasTag
      )
    );

    await DatasetNFT.connect(contributor).proposeFragment(
      datasetId,
      contributor.address,
      datasetSchemasTag,
      proposeSignatureSchemas
    );

    const datasetFragmentAddress = await DatasetNFT.fragments(datasetId);

    const AcceptManuallyVerifier = (await ethers.getContract(
      "AcceptManuallyVerifier"
    )) as unknown as AcceptManuallyVerifier;

    await AcceptManuallyVerifier.connect(datasetOwner).resolve(
      datasetFragmentAddress,
      nextPendingFragmentId,
      true
    );

    await DatasetDistributionManager.connect(
      datasetOwner
    ).setDatasetOwnerPercentage(ethers.parseUnits("0.001", 18));

    const Token = await getTestTokenContract(subscriber, {
      mint: parseUnits("100000000", 18),
    });

    const tokenAddress = await Token.getAddress();

    await Token.connect(subscriber).approve(
      await DatasetSubscriptionManager.getAddress(),
      MaxUint256
    );

    await DatasetDistributionManager.connect(datasetOwner).setTagWeights(
      [datasetSchemasTag, datasetRowsTag],
      [parseUnits("0.4", 18), parseUnits("0.6", 18)]
    );

    const feeAmount = parseUnits("0.1", 18);

    await DatasetSubscriptionManager.connect(datasetOwner).setFee(
      tokenAddress,
      feeAmount
    );

    const subscriptionStart =
      Number((await ethers.provider.getBlock("latest"))?.timestamp) + 1;

    await DatasetSubscriptionManager.connect(subscriber).subscribe(
      datasetId,
      subscriptionStart,
      constants.ONE_WEEK,
      1
    );

    const validSince =
      Number((await ethers.provider.getBlock("latest"))?.timestamp) +
      1 +
      constants.ONE_WEEK * 2;
    const validTill = validSince + constants.ONE_DAY;
    const fragmentOwnerSignature = await dtAdmin.signMessage(
      signature.getFragmentOwnerClaimMessage(
        network.config.chainId!,
        await DatasetDistributionManager.getAddress(),
        contributor.address,
        BigInt(validSince),
        BigInt(validTill)
      )
    );

    await expect(
      DatasetDistributionManager.connect(contributor).claimPayouts(
        validSince,
        validTill,
        fragmentOwnerSignature
      )
    ).to.be.revertedWith("signature overdue");
  });

  it("Should calculate contributor payout before claiming", async function () {
    const {
      DatasetDistributionManager,
      DatasetSubscriptionManager,
      DatasetVerifierManager,
      DatasetNFT,
      datasetId,
    } = await setup();
    const { datasetOwner, dtAdmin, contributor, subscriber } =
      await ethers.getNamedSigners();

    const datasetSchemasTag = utils.encodeTag("dataset.schemas");
    const datasetRowsTag = utils.encodeTag("dataset.rows");

    const fragmentAddress = await DatasetNFT.fragments(datasetId);
    const DatasetFragment = (await ethers.getContractAt(
      "FragmentNFT",
      fragmentAddress
    )) as unknown as FragmentNFT;

    const nextPendingFragmentId =
      (await DatasetFragment.lastFragmentPendingId()) + 1n;

    const proposeSignatureSchemas = await dtAdmin.signMessage(
      signature.getDatasetFragmentProposeMessage(
        network.config.chainId!,
        await DatasetNFT.getAddress(),
        datasetId,
        nextPendingFragmentId,
        contributor.address,
        datasetSchemasTag
      )
    );

    await DatasetNFT.connect(contributor).proposeFragment(
      datasetId,
      contributor.address,
      datasetSchemasTag,
      proposeSignatureSchemas
    );

    const datasetFragmentAddress = await DatasetNFT.fragments(datasetId);

    const AcceptManuallyVerifier = (await ethers.getContract(
      "AcceptManuallyVerifier"
    )) as unknown as AcceptManuallyVerifier;

    await AcceptManuallyVerifier.connect(datasetOwner).resolve(
      datasetFragmentAddress,
      nextPendingFragmentId,
      true
    );

    await DatasetDistributionManager.connect(
      datasetOwner
    ).setDatasetOwnerPercentage(ethers.parseUnits("0.001", 18));

    const Token = await getTestTokenContract(subscriber, {
      mint: parseUnits("100000000", 18),
    });

    const tokenAddress = await Token.getAddress();

    await Token.connect(subscriber).approve(
      await DatasetSubscriptionManager.getAddress(),
      MaxUint256
    );

    await DatasetDistributionManager.connect(datasetOwner).setTagWeights(
      [datasetSchemasTag, datasetRowsTag],
      [parseUnits("0.4", 18), parseUnits("0.6", 18)]
    );

    const feeAmount = parseUnits("0.1", 18);

    await DatasetSubscriptionManager.connect(datasetOwner).setFee(
      tokenAddress,
      feeAmount
    );

    const subscriptionStart =
      Number((await ethers.provider.getBlock("latest"))?.timestamp) + 1;

    await DatasetSubscriptionManager.connect(subscriber).subscribe(
      datasetId,
      subscriptionStart,
      constants.ONE_WEEK,
      1
    );

    expect(
      await DatasetDistributionManager.calculatePayoutByToken(
        tokenAddress,
        datasetOwner.address
      )
    ).to.equal(parseUnits("12083.904", 18));
  });
});
