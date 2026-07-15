<template>
  <div class="modal fade" id="showVoucherInv" tabindex="-1" role="dialog" aria-hidden="true">
    <div class="modal-dialog modal-xl modal-dialog-centered" role="document">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title">برگه دریافت فاکتور شماره <span class="invNo">{{invHeader.InvNo}}</span></h5>
          <button type="button" class="close" data-dismiss="modal" aria-label="بستن"><i class="ti-close"></i></button>
        </div>

        <b-skeleton-table v-if="!vouchLoaded" :rows="2" :columns="1" :table-props="{ bordered: true, striped: true }"></b-skeleton-table>
        <div v-else class="modal-body">

          <div class="table-responsive">
            <table class="table table-hover">
              <thead>
              <tr>
                <th width="70">ردیف</th>
                <th width="300">توضیح</th>
                <th width="150">مبلغ</th>
                <th>نوع پرداخت</th>
              </tr>
              </thead>
              <tbody>
              <tr v-if="!items.length">
                <td colspan="4" class="text-center">-- هیچ برگه دریافتی برای نمایش وجود ندارد --</td>
              </tr>
              <tr v-else v-for="(item, index) of items">
                <td>{{index+1}}</td>
                <td>{{item.VuchLineDesc}}</td>
                <td>{{number_format(item.Amount)}}</td>
                <td>{{item.PayTypeDesc}}</td>
              </tr>
              </tbody>
            </table>
          </div>

          <hr>

          <div class="row">
            <div class="col-lg-6 text-right d-flex align-items-end">

            </div>
            <div class="col-lg-6 text-left">
              <table class="table text-right">
                <tbody>
                <tr>
                  <td class="border-top-0" width="130">جمع:</td>
                  <td class="border-top-0">{{number_format(sumItems)}}</td>
                  <td class="border-top-0"></td>
                </tr>
                <tr>
                  <td>مبلغ کل فاکتور:</td>
                  <td>{{number_format(sumInv)}}</td>
                  <td></td>
                </tr>
                <tr>
                  <td>مانده:</td>
                  <td>{{number_format(sumInv - sumItems)}}</td>
                  <td></td>
                </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import axios from "axios";
import util from "../assets/pureFunctions";

export default {
  data(){
    return {
      items: [],
      sumItems: 0,
      vouchLoaded: false,
      number_format: util.number_format,
    }
  },
  props: ['invHeader', 'sumInv'],
  methods: {
    getVoucherItems(){
      this.vouchLoaded = false;
      axios.post('https://shygun.4mk.ir/api/products/getVoucherItems', {id: this.invHeader.InvHeaderId}).then(({data}) => {
        if( data && data.ok ){
          this.items = data.body;
          this.sumItems = 0;
          for(let item of this.items){
            this.sumItems += item.Amount;
          }
        }else{
          toastr['error']("خطا در فراخوانی داده ها");
          $('#showVoucherInv').modal('hide');
        }
        this.vouchLoaded = true;
      });
    }
  },
  mounted() {
    const vm = this;
    $(document).ready(function () {
      $('#showVoucherInv').on('show.bs.modal', function (event) {
        vm.getVoucherItems();
        $('#showInv').hide();
      });
      $('#showVoucherInv').on('hide.bs.modal', function (event) {
        $('#showInv').show();
      });
      // $('#showVoucherInv').on('show.bs.modal', function (event) {
      //   var el = $(event.relatedTarget), modal = $(this), i = el.data('index');
      //   modal.find('.invNo').text(vm.invHeaders[i].InvNo);
      //   var invtype = el.data('invtype') ? el.data('invtype') : "";
      //   vm.showInvoice(vm.invHeaders[i].InvNo, vm.invHeaders[i].InvHeaderId, invtype);
      // });
    });
  }
}
</script>
