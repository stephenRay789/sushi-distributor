import chai, { expect } from 'chai'
import { solidity, MockProvider, deployContract } from 'ethereum-waffle'
import { Contract, BigNumber, constants } from 'ethers'
import BalanceTree from '../src/balance-tree'

import Distributor from '../artifacts/contracts/MerkleDistributor.sol/MerkleDistributor.json'
import TestERC20 from '../artifacts/contracts/test/TestERC20.sol/TestERC20.json'
import { parseBalanceMap } from '../src/parse-balance-map'

chai.use(solidity)

const overrides = {
  gasLimit: 9999999,
}

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000'
const ONE_BYTES32 = '0x1111111111111111111111111111111111111111111111111111111111111111'

describe('MerkleDistributor', () => {
  const provider = new MockProvider({
    ganacheOptions: {
      hardfork: 'istanbul',
      mnemonic: 'horn horn horn horn horn horn horn horn horn horn horn horn',
      gasLimit: 9999999,
    },
  })

  const wallets = provider.getWallets()
  const [wallet0, wallet1] = wallets

  let token: Contract
  beforeEach('deploy token', async () => {
    token = await deployContract(wallet0, TestERC20, ['Token', 'TKN', 0], overrides)
  })

  describe('#token', () => {
    it('returns the token address', async () => {
      const distributor = await deployContract(wallet0, Distributor, [token.address, ZERO_BYTES32], overrides)
      expect(await distributor.token()).to.eq(token.address)
    })
  })

  describe('#merkleRoot', () => {
    it('returns the zero merkle root', async () => {
      const distributor = await deployContract(wallet0, Distributor, [token.address, ZERO_BYTES32], overrides)
      expect(await distributor.merkleRoot()).to.eq(ZERO_BYTES32)
    })
  })

  describe('#week', () => {
    it('returns the 0th week', async () => {
      const distributor = await deployContract(wallet0, Distributor, [token.address, ZERO_BYTES32], overrides)
      expect(await distributor.week()).to.eq(0)
    })
  })

  describe('#claim', () => {
    it('fails for empty proof', async () => {
      const distributor = await deployContract(wallet0, Distributor, [token.address, ZERO_BYTES32], overrides)
      await expect(distributor.claim(0, wallet0.address, 10, [])).to.be.revertedWith(
        'MerkleDistributor: Invalid proof.'
      )
    })

    it('fails for invalid index', async () => {
      const distributor = await deployContract(wallet0, Distributor, [token.address, ZERO_BYTES32], overrides)
      await expect(distributor.claim(0, wallet0.address, 10, [])).to.be.revertedWith(
        'MerkleDistributor: Invalid proof.'
      )
    })

    it('fails when frozen', async () => {
      const distributor = await deployContract(wallet0, Distributor, [token.address, ZERO_BYTES32], overrides)
      await distributor.freeze()
      await expect(distributor.claim(0, wallet0.address, 0, [ZERO_BYTES32], overrides)).to.be.revertedWith(
        'MerkleDistributor: Claiming is frozen.'
      )
    })

    describe('two account tree', () => {
      let distributor: Contract
      let tree: BalanceTree
      beforeEach('deploy', async () => {
        tree = new BalanceTree([
          { account: wallet0.address, amount: BigNumber.from(100) },
          { account: wallet1.address, amount: BigNumber.from(101) },
        ])
        distributor = await deployContract(wallet0, Distributor, [token.address, tree.getHexRoot()], overrides)
        await token.setBalance(distributor.address, 201)
      })

      it('successful claim', async () => {
        let distributorFromClaimer = distributor.connect(wallets.find(wallet => wallet.address == wallet0.address))
        const proof0 = tree.getProof(0, wallet0.address, BigNumber.from(100))
        await expect(distributorFromClaimer.claim(0, wallet0.address, 100, proof0, overrides))
          .to.emit(distributor, 'Claimed')
          .withArgs(0, 100, wallet0.address, 0)
        
        distributorFromClaimer = distributor.connect(wallets.find(wallet => wallet.address == wallet1.address))
        const proof1 = tree.getProof(1, wallet1.address, BigNumber.from(101))
        await expect(distributorFromClaimer.claim(1, wallet1.address, 101, proof1, overrides))
          .to.emit(distributor, 'Claimed')
          .withArgs(1, 101, wallet1.address, 0)
      })

      it('transfers the token', async () => {
        const proof0 = tree.getProof(0, wallet0.address, BigNumber.from(100))
        expect(await token.balanceOf(wallet0.address)).to.eq(0)
        await distributor.claim(0, wallet0.address, 100, proof0, overrides)
        expect(await token.balanceOf(wallet0.address)).to.eq(100)
      })

      it('must have enough to transfer', async () => {
        const proof0 = tree.getProof(0, wallet0.address, BigNumber.from(100))
        await token.setBalance(distributor.address, 99)
        await expect(distributor.claim(0, wallet0.address, 100, proof0, overrides)).to.be.revertedWith(
          'ERC20: transfer amount exceeds balance'
        )
      })

      it('sets #isClaimed', async () => {
        const proof0 = tree.getProof(0, wallet0.address, BigNumber.from(100))
        expect(await distributor.isClaimed(0)).to.eq(false)
        expect(await distributor.isClaimed(1)).to.eq(false)
        await distributor.claim(0, wallet0.address, 100, proof0, overrides)
        expect(await distributor.isClaimed(0)).to.eq(true)
        expect(await distributor.isClaimed(1)).to.eq(false)
      })

      it('cannot allow two claims', async () => {
        const proof0 = tree.getProof(0, wallet0.address, BigNumber.from(100))
        await distributor.claim(0, wallet0.address, 100, proof0, overrides)
        await expect(distributor.claim(0, wallet0.address, 100, proof0, overrides)).to.be.revertedWith(
          'MerkleDistributor: Drop already claimed.'
        )
      })

      it('cannot claim more than once: 0 and then 1', async () => {
        let distributorFromClaimer = distributor.connect(wallets.find(wallet => wallet.address == wallet0.address))
        await distributorFromClaimer.claim(
          0,
          wallet0.address,
          100,
          tree.getProof(0, wallet0.address, BigNumber.from(100)),
          overrides
        )

        distributorFromClaimer = distributor.connect(wallets.find(wallet => wallet.address == wallet1.address))
        await distributorFromClaimer.claim(
          1,
          wallet1.address,
          101,
          tree.getProof(1, wallet1.address, BigNumber.from(101)),
          overrides
        )

        await expect(
          distributor.claim(0, wallet0.address, 100, tree.getProof(0, wallet0.address, BigNumber.from(100)), overrides)
        ).to.be.revertedWith('MerkleDistributor: Drop already claimed.')
      })

      it('cannot claim more than once: 1 and then 0', async () => {
        let distributorFromClaimer = distributor.connect(wallets.find(wallet => wallet.address == wallet1.address))
        await distributorFromClaimer.claim(
          1,
          wallet1.address,
          101,
          tree.getProof(1, wallet1.address, BigNumber.from(101)),
          overrides
        )

        distributorFromClaimer = distributor.connect(wallets.find(wallet => wallet.address == wallet0.address))
        await distributor.claim(
          0,
          wallet0.address,
          100,
          tree.getProof(0, wallet0.address, BigNumber.from(100)),
          overrides
        )

        await expect(
          distributor.claim(1, wallet1.address, 101, tree.getProof(1, wallet1.address, BigNumber.from(101)), overrides)
        ).to.be.revertedWith('MerkleDistributor: Drop already claimed.')
      })

      it('cannot claim for address other than proof', async () => {
        let distributorFromClaimer = distributor.connect(wallets.find(wallet => wallet.address == wallet1.address))
        const proof0 = tree.getProof(0, wallet0.address, BigNumber.from(100))
        await expect(distributorFromClaimer.claim(1, wallet1.address, 101, proof0, overrides)).to.be.revertedWith(
          'MerkleDistributor: Invalid proof.'
        )
      })

      it('cannot claim more than proof', async () => {
        const proof0 = tree.getProof(0, wallet0.address, BigNumber.from(100))
        await expect(distributor.claim(0, wallet0.address, 101, proof0, overrides)).to.be.revertedWith(
          'MerkleDistributor: Invalid proof.'
        )
      })

      it('gas', async () => {
        const proof = tree.getProof(0, wallet0.address, BigNumber.from(100))
        const tx = await distributor.claim(0, wallet0.address, 100, proof, overrides)
        const receipt = await tx.wait()
        expect(receipt.gasUsed).to.eq(83275)
      })
    })
    describe('larger tree', () => {
      let distributor: Contract
      let tree: BalanceTree
      beforeEach('deploy', async () => {
        tree = new BalanceTree(
          wallets.map((wallet, ix) => {
            return { account: wallet.address, amount: BigNumber.from(ix + 1) }
          })
        )
        distributor = await deployContract(wallet0, Distributor, [token.address, tree.getHexRoot()], overrides)
        await token.setBalance(distributor.address, 201)
      })

      it('claim index 4', async () => {
        const distributorFromClaimer = distributor.connect(wallets.find(wallet => wallet.address == wallets[4].address))
        const proof = tree.getProof(4, wallets[4].address, BigNumber.from(5))
        await expect(distributorFromClaimer.claim(4, wallets[4].address, 5, proof, overrides))
          .to.emit(distributor, 'Claimed')
          .withArgs(4, 5, wallets[4].address, 0)
      })

      it('claim index 9', async () => {
        const distributorFromClaimer = distributor.connect(wallets.find(wallet => wallet.address == wallets[9].address))
        const proof = tree.getProof(9, wallets[9].address, BigNumber.from(10))
        await expect(distributorFromClaimer.claim(9, wallets[9].address, 10, proof, overrides))
          .to.emit(distributor, 'Claimed')
          .withArgs(9, 10, wallets[9].address, 0)
      })

      it('gas', async () => {
        const distributorFromClaimer = distributor.connect(wallets.find(wallet => wallet.address == wallets[9].address))
        const proof = tree.getProof(9, wallets[9].address, BigNumber.from(10))
        const tx = await distributorFromClaimer.claim(9, wallets[9].address, 10, proof, overrides)
        const receipt = await tx.wait()
        expect(receipt.gasUsed).to.eq(85769)
      })

      it('gas second down about 15k', async () => {
        let distributorFromClaimer = distributor.connect(wallets.find(wallet => wallet.address == wallets[0].address))
        await distributorFromClaimer.claim(
          0,
          wallets[0].address,
          1,
          tree.getProof(0, wallets[0].address, BigNumber.from(1)),
          overrides
        )
        
        distributorFromClaimer = distributor.connect(wallets.find(wallet => wallet.address == wallets[1].address))
        const tx = await distributorFromClaimer.claim(
          1,
          wallets[1].address,
          2,
          tree.getProof(1, wallets[1].address, BigNumber.from(2)),
          overrides
        )
        const receipt = await tx.wait()
        expect(receipt.gasUsed).to.eq(70749)
      })
    })

    describe('realistic size tree', () => {
      let distributor: Contract
      let tree: BalanceTree
      const NUM_LEAVES = 100_000
      const NUM_SAMPLES = 25
      const elements: { account: string; amount: BigNumber }[] = []
      for (let i = 0; i < NUM_LEAVES; i++) {
        const node = { account: wallet0.address, amount: BigNumber.from(100) }
        elements.push(node)
      }
      tree = new BalanceTree(elements)

      it('proof verification works', () => {
        const root = Buffer.from(tree.getHexRoot().slice(2), 'hex')
        for (let i = 0; i < NUM_LEAVES; i += NUM_LEAVES / NUM_SAMPLES) {
          const proof = tree
            .getProof(i, wallet0.address, BigNumber.from(100))
            .map((el) => Buffer.from(el.slice(2), 'hex'))
          const validProof = BalanceTree.verifyProof(i, wallet0.address, BigNumber.from(100), proof, root)
          expect(validProof).to.be.true
        }
      })

      beforeEach('deploy', async () => {
        distributor = await deployContract(wallet0, Distributor, [token.address, tree.getHexRoot()], overrides)
        await token.setBalance(distributor.address, constants.MaxUint256)
      })

      it('gas', async () => {
        const proof = tree.getProof(50000, wallet0.address, BigNumber.from(100))
        const tx = await distributor.claim(50000, wallet0.address, 100, proof, overrides)
        const receipt = await tx.wait()
        expect(receipt.gasUsed).to.eq(96459)
      })
      it('gas deeper node', async () => {
        const proof = tree.getProof(90000, wallet0.address, BigNumber.from(100))
        const tx = await distributor.claim(90000, wallet0.address, 100, proof, overrides)
        const receipt = await tx.wait()
        expect(receipt.gasUsed).to.eq(96395)
      })
      it('gas average random distribution', async () => {
        let total: BigNumber = BigNumber.from(0)
        let count: number = 0
        for (let i = 0; i < NUM_LEAVES; i += NUM_LEAVES / NUM_SAMPLES) {
          const proof = tree.getProof(i, wallet0.address, BigNumber.from(100))
          const tx = await distributor.claim(i, wallet0.address, 100, proof, overrides)
          const receipt = await tx.wait()
          total = total.add(receipt.gasUsed)
          count++
        }
        const average = total.div(count)
        expect(average).to.eq(81884)
      })
      // this is what we gas golfed by packing the bitmap
      it('gas average first 25', async () => {
        let total: BigNumber = BigNumber.from(0)
        let count: number = 0
        for (let i = 0; i < 25; i++) {
          const proof = tree.getProof(i, wallet0.address, BigNumber.from(100))
          const tx = await distributor.claim(i, wallet0.address, 100, proof, overrides)
          const receipt = await tx.wait()
          total = total.add(receipt.gasUsed)
          count++
        }
        const average = total.div(count)
        expect(average).to.eq(67633)
      })

      it('no double claims in random distribution', async () => {
        for (let i = 0; i < 25; i += Math.floor(Math.random() * (NUM_LEAVES / NUM_SAMPLES))) {
          const proof = tree.getProof(i, wallet0.address, BigNumber.from(100))
          await distributor.claim(i, wallet0.address, 100, proof, overrides)
          await expect(distributor.claim(i, wallet0.address, 100, proof, overrides)).to.be.revertedWith(
            'MerkleDistributor: Drop already claimed.'
          )
        }
      })
    })
  })

  describe('#freeze', () => {
    it('changes the frozen var to true', async () => {
      const distributor = await deployContract(wallet0, Distributor, [token.address, ZERO_BYTES32], overrides)
      await distributor.freeze()
      expect(await distributor.frozen()).to.eq(true)
    })

    it('fails if not called by owner', async () => {
      const distributor = await deployContract(wallet0, Distributor, [token.address, ZERO_BYTES32], overrides)
      const distributorFromOtherWallet = distributor.connect(wallet1)
      expect(distributorFromOtherWallet.freeze()).to.be.revertedWith('Ownable: caller is not the owner')
    })
  })

  describe('#unfreeze', () => {
    it('changes the frozen var to false', async () => {
      const distributor = await deployContract(wallet0, Distributor, [token.address, ZERO_BYTES32], overrides)
      await distributor.unfreeze()
      expect(await distributor.frozen()).to.eq(false)
    })

    it('fails if not called by owner', async () => {
      const distributor = await deployContract(wallet0, Distributor, [token.address, ZERO_BYTES32], overrides)
      const distributorFromOtherWallet = distributor.connect(wallet1)
      expect(distributorFromOtherWallet.unfreeze()).to.be.revertedWith('Ownable: caller is not the owner')
    })
  })

  describe('#updateMerkleRoot', () => {
    it('fails when not frozen', async () => {
      const distributor = await deployContract(wallet0, Distributor, [token.address, ZERO_BYTES32], overrides)
      await expect(distributor.updateMerkleRoot(ONE_BYTES32)).to.be.revertedWith(
        'MerkleDistributor: Contract not frozen.'
      )
    })

    it('updates the merkle root', async () => {
      const distributor = await deployContract(wallet0, Distributor, [token.address, ZERO_BYTES32], overrides)
      await distributor.freeze()
      await expect(distributor.updateMerkleRoot(ONE_BYTES32))
        .to.emit(distributor, 'MerkleRootUpdated')
        .withArgs(ONE_BYTES32, 1)
      expect(await distributor.merkleRoot()).to.eq(ONE_BYTES32)
    })

    it('increments the week', async () => {
      const distributor = await deployContract(wallet0, Distributor, [token.address, ZERO_BYTES32], overrides)
      await distributor.freeze()
      await distributor.updateMerkleRoot(ONE_BYTES32)
      expect(await distributor.week()).to.eq(1)
    })

    it('fails if not called by owner', async () => {
      const distributor = await deployContract(wallet0, Distributor, [token.address, ZERO_BYTES32], overrides)
      const distributorFromOtherWallet = distributor.connect(wallet1)
      expect(distributorFromOtherWallet.updateMerkleRoot(ONE_BYTES32)).to.be.revertedWith(
        'Ownable: caller is not the owner'
      )
    })
  })

  describe('parseBalanceMap', () => {
    let distributor: Contract
    let claims: {
      [account: string]: {
        index: number
        amount: string
        proof: string[]
      }
    }
    beforeEach('deploy', async () => {
      const { claims: innerClaims, merkleRoot, tokenTotal } = parseBalanceMap({
        [wallet0.address]: 200,
        [wallet1.address]: 300,
        [wallets[2].address]: 250,
      })
      expect(tokenTotal).to.eq('0x02ee') // 750
      claims = innerClaims
      distributor = await deployContract(wallet0, Distributor, [token.address, merkleRoot], overrides)
      await token.setBalance(distributor.address, tokenTotal)
    })

    it('check the proofs is as expected', () => {
      expect(claims).to.deep.eq({
        [wallet0.address]: {
          index: 0,
          amount: '0xc8',
          proof: ['0x2a411ed78501edb696adca9e41e78d8256b61cfac45612fa0434d7cf87d916c6'],
        },
        [wallet1.address]: {
          index: 1,
          amount: '0x012c',
          proof: [
            '0xbfeb956a3b705056020a3b64c540bff700c0f6c96c55c0a5fcab57124cb36f7b',
            '0xd31de46890d4a77baeebddbd77bf73b5c626397b73ee8c69b51efe4c9a5a72fa',
          ],
        },
        [wallets[2].address]: {
          index: 2,
          amount: '0xfa',
          proof: [
            '0xceaacce7533111e902cc548e961d77b23a4d8cd073c6b68ccf55c62bd47fc36b',
            '0xd31de46890d4a77baeebddbd77bf73b5c626397b73ee8c69b51efe4c9a5a72fa',
          ],
        },
      })
    })

    it('all claims work exactly once', async () => {
      for (let account in claims) {
        const distributorFromClaimer = distributor.connect(wallets.find(wallet => wallet.address == account))
        const claim = claims[account]
        await expect(distributorFromClaimer.claim(claim.index, account, claim.amount, claim.proof, overrides))
          .to.emit(distributor, 'Claimed')
          .withArgs(claim.index, claim.amount, account, 0)
        await expect(distributorFromClaimer.claim(claim.index, account, claim.amount, claim.proof, overrides)).to.be.revertedWith(
          'MerkleDistributor: Drop already claimed.'
        )
      }
      expect(await token.balanceOf(distributor.address)).to.eq(0)
    })
  })
})
